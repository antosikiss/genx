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

app.get('/generate', async (req, res) => {
  console.log('GET /generate received with query:', JSON.stringify(req.query));
  try {
    const recordId = req.query.recordId;
    await handleGenerate(recordId, res);
  } catch (error) {
    console.error('Error in GET /generate:', error.stack || error);
    res.status(500).send('Server error');
  }
});

app.post('/generate', async (req, res) => {
  console.log('POST /generate received with body:', JSON.stringify(req.body));
  try {
    const { recordId } = req.body;
    await handleGenerate(recordId, res);
  } catch (error) {
    console.error('Error in POST /generate:', error.stack || error);
    res.status(500).send('Server error');
  }
});

async function handleGenerate(recordId, res) {
  console.log('handleGenerate called with recordId:', recordId);
  if (!recordId) return res.status(400).send('Missing recordId');

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = 'app5JstpSmtghcbMA';
  const WAVESPEED_API_KEY = process.env.WAVESPEED_API_KEY;
  const APIFY_API_KEY = process.env.APIFY_API_KEY;
  const MAIN_TABLE_NAME = 'Generation';

  if (!AIRTABLE_API_KEY || !WAVESPEED_API_KEY || !APIFY_API_KEY) return res.status(500).send('Missing required env vars');

  const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

  try {
    console.log('Fetching record:', recordId);
    const record = await base(MAIN_TABLE_NAME).find(recordId);
    const fields = record.fields;

    if (!fields.Generate) return res.status(200).send('Generate not triggered');

    await base(MAIN_TABLE_NAME).update(recordId, { Status: 'Generating' });

    let sourceVideoUrl = fields['Source Video'] ? fields['Source Video'][0].url : null;
    let coverImageUrl = fields['Cover Image'] ? fields['Cover Image'][0].url : null;
    const tiktokLink = fields.Link;
    const aiCharacterUrl = fields['AI Character'] ? fields['AI Character'][0].url : null;

    if ((!sourceVideoUrl || !coverImageUrl) && tiktokLink && tiktokLink.includes('tiktok.com') && APIFY_API_KEY) {
      console.log('Downloading video and thumbnail from Apify actor S5h7zRLfKFEr8pdj7');
      const apifyData = {
        urls: [tiktokLink]
      };
      const apifyUrl = `https://api.apify.com/v2/acts/S5h7zRLfKFEr8pdj7/run-sync-get-dataset-items?token=${APIFY_API_KEY}`;
      const apifyRes = await fetch(apifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(apifyData)
      });
      if (!apifyRes.ok) {
        const errText = await apifyRes.text();
        throw new Error(`Apify error: ${apifyRes.statusText} - ${errText}`);
      }
      const apifyJson = await apifyRes.json();
      console.log('Apify response (S5h7zRLfKFEr8pdj7):', JSON.stringify(apifyJson));
      if (apifyJson.length === 0) throw new Error('Empty Apify response');
      const post = apifyJson[0];
      sourceVideoUrl = post.playAddr || post.videoMeta?.playAddr || post.downloadAddr || post.noWatermarkUrl || post.videoDownloadUrl || post.webVideoUrl || post.videoUrl;
      coverImageUrl = post.cover || post.videoMeta?.cover || post.originCover || post.dynamicCover || post.thumbnail;
      if (!sourceVideoUrl) throw new Error('No video URL found in Apify response');
      if (!sourceVideoUrl.endsWith('.mp4')) sourceVideoUrl += '.mp4';
      console.log('Final Source Video URL (forced):', sourceVideoUrl);
    }

    if (!sourceVideoUrl) throw new Error('Missing Source Video');

    await base(MAIN_TABLE_NAME).update(recordId, {
      'Source Video': [{ url: sourceVideoUrl }],
      'Cover Image': coverImageUrl ? [{ url: coverImageUrl }] : []
    });

    const faceImageUrl = aiCharacterUrl || coverImageUrl;
    if (!faceImageUrl) throw new Error('Missing AI Character or Cover Image for face swap');

    console.log('Generating images with Seedream v4.5 on Wavespeed');
    const seedreamUuid = 'bytedance/seedream-v4.5/edit';
    const seedreamUrl = `https://api.wavespeed.ai/api/v3/${seedreamUuid}`;
    const seedreamData = {
      images: [faceImageUrl],
      prompt: 'high quality portrait, detailed face, realistic skin, sharp eyes',
      width: 1728,
      height: 2304,
      wait: true
    };
    const seedreamRes = await fetch(seedreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WAVESPEED_API_KEY}`
      },
      body: JSON.stringify(seedreamData)
    });
    if (!seedreamRes.ok) throw new Error(`Seedream error: ${seedreamRes.statusText}`);
    const seedreamJson = await seedreamRes.json();
    const generatedImages = (seedreamJson.output || []).map(url => ({ url }));
    if (generatedImages.length === 0) throw new Error('No generated images from Seedream');

    await base(MAIN_TABLE_NAME).update(recordId, { 'Generated Images': generatedImages });

    console.log('Performing animation with Kling 2.6 Motion Control on Wavespeed');
    const klingUuid = 'kwaivgi/kling-v2.6-std/motion-control';
    const klingUrl = `https://api.wavespeed.ai/api/v3/${klingUuid}`;
    const klingData = {
      character_image: generatedImages[0].url,
      motion_video: sourceVideoUrl,
      resolution: '720p'
    };
    const klingRes = await fetch(klingUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WAVESPEED_API_KEY}`
      },
      body: JSON.stringify(klingData)
    });
    if (!klingRes.ok) throw new Error(`Kling error: ${klingRes.statusText}`);
    const klingJson = await klingRes.json();
    const outputVideoUrl = klingJson.output_video_url;

    await base(MAIN_TABLE_NAME).update(recordId, {
      'Output Video': [{ url: outputVideoUrl }],
      Status: 'Complete',
      Generate: false
    });
    res.status(200).send('Generation complete');

  } catch (error) {
    console.error('Error during generation:', error.message, error.stack);
    try {
      await base(MAIN_TABLE_NAME).update(recordId, {
        Status: 'Failed',
        Generate: false
      });
    } catch (updateError) {
      console.error('Update failed:', updateError.message, updateError.stack);
    }
    res.status(500).send(error.message || 'Unknown error');
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
