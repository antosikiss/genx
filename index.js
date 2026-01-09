const express = require('express');
const fetch = require('node-fetch');
const Airtable = require('airtable');
const app = express();
app.use(express.json());

// Global error logging
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', (error) => console.error('Uncaught Exception:', error));

app.post('/generate', async (req, res) => {
  const { recordId } = req.body;
  if (!recordId) return res.status(400).send('Missing recordId');

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  const WAVESPEED_API_KEY = process.env.WAVESPEED_API_KEY;
  const APIFY_API_KEY = process.env.APIFY_API_KEY;

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !WAVESPEED_API_KEY || !APIFY_API_KEY) {
    return res.status(500).send('Missing environment variables');
  }

  const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

  try {
    const record = await base('Generation').find(recordId);
    const fields = record.fields;

    if (!fields.Generate) return res.send('Generate not checked');

    await base('Generation').update(recordId, { Status: 'Generating' });

    // 1. Download TikTok video with Apify
    let sourceVideoUrl = null;
    let coverImageUrl = null;

    if (fields.Link && fields.Link.includes('tiktok.com')) {
      const apifyData = { urls: [fields.Link] };
      const apifyResponse = await fetch(
        `https://api.apify.com/v2/acts/S5h7zRLfKFEr8pdj7/run-sync-get-dataset-items?token=${APIFY_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(apifyData)
        }
      );

      if (!apifyResponse.ok) throw new Error('Apify failed');

      const data = await apifyResponse.json();
      if (data.length > 0) {
        sourceVideoUrl = data[0].playAddr || data[0].videoMeta?.playAddr || data[0].downloadAddr;
        coverImageUrl = data[0].cover || data[0].videoMeta?.cover;
        if (sourceVideoUrl && !sourceVideoUrl.endsWith('.mp4')) sourceVideoUrl += '.mp4';
      }
    }

    if (!sourceVideoUrl) throw new Error('Could not download video');

    await base('Generation').update(recordId, {
      'Source Video': [{ url: sourceVideoUrl }],
      'Cover Image': coverImageUrl ? [{ url: coverImageUrl }] : []
    });

    // 2. Face from AI Character
    const faceImage = fields['AI Character']?.[0]?.url;
    if (!faceImage) throw new Error('No AI Character image');

    // 3. Seedream v4.5 on Wavespeed
    const seedreamResponse = await fetch(
      'https://api.wavespeed.ai/api/v3/bytedance/seedream-v4.5/edit',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${WAVESPEED_API_KEY}`
        },
        body: JSON.stringify({
          images: [faceImage],
          prompt: 'high quality portrait, detailed face, realistic skin, sharp eyes',
          width: 1728,
          height: 2304
        })
      }
    );

    if (!seedreamResponse.ok) throw new Error('Seedream failed');

    const seedreamResult = await seedreamResponse.json();
    const generatedFaceUrl = seedreamResult.output?.[0];

    if (!generatedFaceUrl) throw new Error('No face generated');

    await base('Generation').update(recordId, {
      'Generated Images': [{ url: generatedFaceUrl }]
    });

    // 4. Kling 2.6 Motion Control on Wavespeed
    const klingResponse = await fetch(
      'https://api.wavespeed.ai/api/v3/kwaivgi/kling-v2.6-std/motion-control',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${WAVESPEED_API_KEY}`
        },
        body: JSON.stringify({
          character_image: generatedFaceUrl,
          motion_video: sourceVideoUrl,
          resolution: '720p'
        })
      }
    );

    if (!klingResponse.ok) throw new Error('Kling failed');

    const klingResult = await klingResponse.json();
    const klingId = klingResult.id;
    const finalResult = await pollWavespeedResult(klingId);

    const finalVideoUrl = finalResult.output_video_url;

    if (!finalVideoUrl) throw new Error('No final video');

    // 5. Save final result
    await base('Generation').update(recordId, {
      'Output Video': [{ url: finalVideoUrl }],
      Status: 'Complete',
      Generate: false
    });

    res.send('Success');
  } catch (error) {
    console.error(error);
    try {
      await base('Generation').update(recordId, {
        Status: 'Failed',
        'Error Message': error.message
      });
    } catch {}
    res.status(500).send(error.message);
  }
}

async function pollWavespeedResult(id, maxAttempts = 60, interval = 5000) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, interval));
    const pollRes = await fetch(`https://api.wavespeed.ai/api/v3/predictions/${id}/result`, {
      headers: { 'Authorization': `Bearer ${process.env.WAVESPEED_API_KEY}` }
    });
    if (!pollRes.ok) continue;
    const pollJson = await pollRes.json();
    if (pollJson.status === 'completed') return pollJson;
    if (pollJson.status === 'failed') throw new Error('Job failed');
  }
  throw new Error('Timeout');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
