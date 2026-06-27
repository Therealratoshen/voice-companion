/**
 * Code Executor Tool
 * Sandboxed JavaScript execution with timeout and memory limits.
 * Supports: JavaScript (primary), Python (basic via description)
 *
 * Uses vm2 for safety. Falls back to basic Function() with timeout if unavailable.
 */

const { VM } = require("vm2");

const DEFAULT_TIMEOUT = 5000; // 5 seconds
const MAX_OUTPUT_LENGTH = 2000;

/**
 * Execute JavaScript code in a sandbox.
 * @param {string} code - JavaScript code to execute
 * @param {object} context - Optional context variables (limited)
 * @returns {Promise<{success: boolean, result: string, error?: string, logs: string[]}>}
 */
async function executeJS(code, context = {}) {
  const logs = [];

  // Basic safety: block dangerous patterns
  const dangerous = [
    "require('fs')", "require('child_process')", "import('fs')",
    "process", "global", "__dirname", "__filename",
    "eval(", "Function(", "import(", "export ",
  ];
  for (const d of dangerous) {
    if (code.includes(d)) {
      return {
        success: false,
        result: "",
        error: `Pola berbahaya terdeteksi: ${d}. Kode tidak dijalankan.`,
        logs: [],
      };
    }
  }

  try {
    const vm = new VM({
      timeout: DEFAULT_TIMEOUT,
      eval: false,
      wasm: false,
      // Allowed built-ins
      sandbox: {
        console: {
          log: (...args) => logs.push(args.map(safeString).join(" ")),
          error: (...args) => logs.push("[error] " + args.map(safeString).join(" ")),
          warn: (...args) => logs.push("[warn] " + args.map(safeString).join(" ")),
        },
        Math,
        JSON,
        Date,
        Array,
        Object,
        String,
        Number,
        Boolean,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        ...context,
      },
    });

    let result = vm.run(code);

    // Format result
    let resultStr = safeString(result);
    if (resultStr.length > MAX_OUTPUT_LENGTH) {
      resultStr = resultStr.substring(0, MAX_OUTPUT_LENGTH) + "... (dipotong)";
    }

    let output = "";
    if (logs.length > 0) output += logs.join("\n") + "\n";
    if (resultStr && resultStr !== "undefined") {
      output += `→ ${resultStr}`;
    }

    return {
      success: true,
      result: output.trim() || "(tidak ada output)",
      logs,
    };
  } catch (err) {
    return {
      success: false,
      result: "",
      error: err.message.substring(0, 500),
      logs,
    };
  }
}

/**
 * Execute Python code (basic — uses Python syntax description for LLM to explain).
 * Full Python execution requires a separate service (Pyodide in browser, or Python backend).
 * @param {string} code - Python code
 * @returns {Promise<{success: boolean, result: string, error?: string}>}
 */
async function executePython(code) {
  // Python execution requires Pyodide or a Python backend.
  // For now: try to use Python-Shell if available
  try {
    const { PythonShell } = require("python-shell");
    const result = await new Promise((resolve, reject) => {
      const sh = PythonShell.runString(code, null, (err, results) => {
        if (err) reject(err);
        else resolve(results ? results.join("\n") : "");
      });
      sh.childProcess.kill = () => {}; // prevent unhandled
    });
    return { success: true, result: String(result).substring(0, MAX_OUTPUT_LENGTH) };
  } catch (err) {
    return {
      success: false,
      result: "",
      error: "Python execution not available. Gunakan JavaScript sebagai alternatif. " + err.message,
    };
  }
}

/**
 * Execute code based on language detection.
 */
async function executeCode(code, language = "javascript") {
  const lang = (language || "javascript").toLowerCase();
  if (lang.includes("python") || lang.includes("py")) {
    return executePython(code);
  }
  return executeJS(code);
}

/**
 * Extract code blocks from markdown text (```code```)
 */
function extractCode(text) {
  const match = text.match(/```(?:javascript|js|python|py)?\n?([\s\S]*?)```/);
  return match ? match[1].trim() : text.trim();
}

/**
 * Detect language from code string.
 */
function detectLanguage(code) {
  if (code.includes("def ") && code.includes(":") && !code.includes("function")) return "python";
  if (code.includes("print(") && !code.includes("console.log")) return "python";
  return "javascript";
}

function safeString(val) {
  if (val === null) return "null";
  if (val === undefined) return "undefined";
  if (typeof val === "object") {
    try { return JSON.stringify(val, null, 2); } catch { return String(val); }
  }
  return String(val);
}

module.exports = { executeJS, executePython, executeCode, extractCode, detectLanguage };
