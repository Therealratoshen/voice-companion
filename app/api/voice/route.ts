import { NextRequest, NextResponse } from 'next/server';
import { searchMemory, logConversation, extractAndSaveMemories, SYSTEM_PROMPT } from '@/lib/memory';
import { groqChat } from '@/lib/groq';
import { minimaxSTT, minimaxTTS } from '@/lib/minimax';

// POST /api/voice
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const userId = formData.get('userId') as string;
    const audioBlob = formData.get('audio') as Blob;

    if (!userId || !audioBlob) {
      return NextResponse.json({ error: 'Missing userId or audio' }, { status: 400 });
    }

    // 1. STT — MiniMax
    const audioBuffer = Buffer.from(await audioBlob.arrayBuffer());
    const transcript = await minimaxSTT(audioBuffer);

    // 2. Log user message
    await logConversation(userId, 'voice', 'user', transcript);

    // 3. Read memory
    const memories = await searchMemory(userId, transcript, 5);
    const memoryContext =
      memories.length > 0
        ? `\n\nWhat you know about this user:\n${memories.map((m: any) => `• ${m.content}`).join('\n')}`
        : '';

    // 4. LLM — Groq
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT + memoryContext },
      { role: 'user', content: transcript },
    ];
    const llmRes = await groqChat(messages);
    const response = llmRes.choices?.[0]?.message?.content || 'Sorry, I missed that.';

    // 5. Log assistant response
    await logConversation(userId, 'voice', 'assistant', response);

    // 6. Extract + save new memories
    await extractAndSaveMemories(userId, transcript, response);

    // 7. TTS — MiniMax
    const audioResponse = await minimaxTTS(response);

    return new NextResponse(new Uint8Array(audioResponse), {
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  } catch (err) {
    console.error('Voice API error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
