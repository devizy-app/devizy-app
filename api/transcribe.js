export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { audio, mimeType } = req.body;
    if (!audio) return res.status(400).json({ error: 'No audio' });

    const buffer = Buffer.from(audio, 'base64');
    const boundary = 'X' + Date.now().toString(16);
    const type = mimeType || 'audio/webm';
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';

    const pre = Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="language"\r\n\r\nfr\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="audio.' + ext + '"\r\n' +
      'Content-Type: ' + type + '\r\n\r\n'
    );
    const post = Buffer.from('\r\n--' + boundary + '--\r\n');
    const body = Buffer.concat([pre, buffer, post]);

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
        'Content-Type': 'multipart/form-data; boundary=' + boundary
      },
      body
    });

    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    res.status(200).json({ text: d.text || '' });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
