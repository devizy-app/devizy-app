export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { audio, mimeType } = req.body;
    if (!audio) return res.status(400).json({ error: 'No audio' });

    const buffer = Buffer.from(audio, 'base64');
    const ext = mimeType && mimeType.includes('mp4') ? 'm4a' : 'webm';

    const { FormData, Blob } = await import('formdata-node');
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType || 'audio/webm' }), 'audio.' + ext);
    form.append('model', 'whisper-1');
    form.append('language', 'fr');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY },
      body: form
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    res.status(200).json({ text: data.text });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
