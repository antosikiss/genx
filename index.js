const express = require('express');
const fetch = require('node-fetch');
const Airtable = require('airtable');
const app = express();
app.use(express.json());

// Global error logging
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason ? reason.stack || reason : 'No reason');
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error.stack || error);
});

// Polling for Wavespeed async jobs
async function pollWavespeedResult(requestId, maxAttempts = 60, interval = 5000) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, interval));
    const pollUrl = `https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`;
    console.log(`Polling attempt ${attempt + 1}: ${pollUrl}`);
    const pollRes = await fetch(pollUrl, {
      headers: { 'Authorization': `Bearer ${process.env.WAVESPEED_API_KEY}` }
    });
    if (!pollRes.ok) {
      console.log('Poll failed:', pollRes.status, pollRes.statusText);
      continue;
    }
    const pollJson = await pollRes.json();
    console.log('Poll response:', JSON.stringify(pollJson));
    if (pollJson.status === 'completed' || pollJson.output) {
      return pollJson;
    }
    if (pollJson.status === 'failed') {
      throw new Error('Job failed: ' + (pollJson.error || 'Unknown'));
    }
  }
  throw new Error('Wavespeed timeout after ' + maxAttempts + ' attempts');
}

app.post('/generate', async (req, res) => {
  const { recordId } = req.body;
  if (!recordId) return res.status(400).send('Missing recordId');

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  const WAVESPEED_API_KEY = process.env.WAVESPEED_API_KEY;
  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
  const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'tiktok-video-downloader-api.p.rapidapi.com';

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !WAVESPEED_API_KEY || !RAPIDAPI_KEY) {
    return res.status(500).send('Missing environment variables');
  }

  const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

  try {
    console.log('Fetching record:', recordId);
    const record = await base('Generation').find(recordId);
    const fields = record.fields;

    if (!fields.Generate) return res.send('Generate not checked');

    await base('Generation').update(recordId, { Status: 'Generating' });

    // 1. Download video from RapidAPI (direct .mp4)
    let sourceVideoUrl = fields['Source Video'] ? fields['Source Video'][0].url : null;
    let coverImageUrl = fields['Cover Image'] ? fields['Cover Image'][0].url : null;

    if ((!sourceVideoUrl || !coverImageUrl) && fields.Link && fields.Link.includes('tiktok.com')) {
      console.log('Downloading from RapidAPI TikTok Downloader');
      const response = await fetch(`https://${RAPIDAPI_HOST}/download`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-RapidAPI-Key': RAPIDAPI_KEY,
          'X-RapidAPI-Host': RAPIDAPI_HOST
        },
        body: JSON.stringify({ url: fields.Link })
      });

      if (!response.ok) throw new Error(`RapidAPI failed: ${response.statusText}`);

      const data = await response.json();
      console.log('RapidAPI response:', JSON.stringify(data));

      sourceVideoUrl = data.data?.no_watermark_url || data.data?.download_url || data.data?.video_url || data.url;
      coverImageUrl = data.data?.thumbnail || data.data?.cover;

      if (!sourceVideoUrl) throw new Error('No video URL from RapidAPI');
      if (!sourceVideoUrl.endsWith('.mp4')) sourceVideoUrl += '.mp4';
      console.log('Direct .mp4 URL from RapidAPI:', sourceVideoUrl);
    }

    if (!sourceVideoUrl) throw new Error('Missing Source Video');

    await base('Generation').update(recordId, {
      'Source Video': [{ url: sourceVideoUrl }],
      'Cover Image': coverImageUrl ? [{ url: coverImageUrl }] : []
    });

    const faceImageUrl = fields['AI Character']?.[0]?.url || coverImageUrl;
    if (!faceImageUrl) throw new Error('Missing AI Character or Cover Image');

    console.log('Generating images with Seedream v4.5 on Wavespeed');
    const seedreamResponse = await fetch(
      'https://api.wavespeed.ai/api/v3/bytedance/seedream-v4.5/edit',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${WAVESPEED_API_KEY}`
        },
        body: JSON.stringify({
          images: [faceImageUrl],
          prompt: 'high quality portrait, detailed face, realistic skin, sharp eyes',
          width: 1728,
          height: 2304
        })
      }
    );

    if (!seedreamResponse.ok) throw new Error('Seedream failed');

    const seedreamJson = await seedreamResponse.json();
    const seedreamId = seedreamJson.id;
    const seedreamResult = await pollWavespeedResult(seedreamId);
    const generatedFaceUrl = seedreamResult.output?.[0];

    if (!generatedFaceUrl) throw new Error('No face generated');

    await base('Generation').update(recordId, {
      'Generated Images': [{ url: generatedFaceUrl }]
    });

    console.log('Running Kling 2.6 Motion Control');
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

    const klingJson = await klingResponse.json();
    const klingId = klingJson.id;
    const finalResult = await pollWavespeedResult(klingId);
    const finalVideoUrl = finalResult.output_video_url;

    if (!finalVideoUrl) throw new Error('No final video');

    await base('Generation').update(recordId, {
      'Output Video': [{ url: finalVideoUrl }],
      Status: 'Complete',
      Generate: false
    });

    res.send('Success');
  } catch (error) {
    console.error('Error:', error.message);
    try {
      await base('Generation').update(recordId, {
        Status: 'Failed',
        'Error Message': error.message
      });
    } catch {}
    res.status(500).send(error.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
