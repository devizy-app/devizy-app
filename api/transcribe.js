export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { audio, mimeType } = req.body;
    if (!audio) return res.status(400).json({ error: { message: 'No audio data' } });

    // Décoder le base64 en buffer
    const buffer = Buffer.from(audio, 'base64');

    // Choisir l'extension selon le mimeType
    const ext = mimeType && mimeType.includes('mp4') ? 'mp4'
              : mimeType && mimeType.includes('ogg') ? 'ogg'
              : mimeType && mimeType.includes('aac') ? 'aac'
              : 'webm';

    // Appel à l'API Whisper d'OpenAI
    const FormData = (await import('formdata-node')).FormData;
    const { Blob } = await import('buffer');

    const formData = new FormData();
    formData.set('file', new Blob([buffer], { type: mimeType || 'audio/webm' }), `audio.${ext}`);
    formData.set('model', 'whisper-1');
    formData.set('language', 'fr');
    formData.set('response_format', 'json');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Whisper HTTP ${response.status}: ${errText.substring(0, 100)}`);
    }

    const data = await response.json();
    res.status(200).json({ text: data.text || '' });

  } catch(e) {
    console.error('[Devizy transcribe]', e.message);
    res.status(500).json({ error: { message: e.message } });
  }
}
