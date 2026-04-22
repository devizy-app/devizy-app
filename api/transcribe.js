export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { audio, mimeType } = req.body;
    if (!audio) return res.status(400).json({ error: 'No audio' });

    const buffer = Buffer.from(audio, 'base64');
    const ext = (mimeType || '').includes('mp4') ? 'm4a' : 
                (mimeType || '').includes('ogg') ? 'ogg' : 'webm';
    const filename = 'audio.' + ext;
    const type = mimeType || 'audio/webm';

    // Construire le multipart manuellement sans dépendances externes
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    
    const header = Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="model"\r\n\r\n' +
      'whisper-1\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="language"\r\n\r\n' +
      'fr\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n' +
      'Content-Type: ' + type + '\r\n\r\n'
    );
    
    const footer = Buffer.from('\r\n--' + boundary + '--\r\n');
    const body = Buffer.concat([header, buffer, footer]);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length.toString()
      },
      body: body
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    res.status(200).json({ text: data.text || '' });

  } catch(e) {
    console.error('[transcribe]', e.message);
    res.status(500).json({ error: e.message });
  }
}
