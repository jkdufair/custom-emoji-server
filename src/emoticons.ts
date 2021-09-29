import * as bodyParser from 'body-parser';
import express, { Router } from 'express';
import { createNodeRedisClient as createClient } from 'handy-redis';
import { promisify } from 'util';

export const emoticonRouter = express.Router();

interface EmoticonMap { [emoticon: string]: string; }

const emoticonMatch = /[^~]+/;
const emojiListPath = './assets/emoji/';

emoticonRouter.use((req, res, next) => {
  const origin = res.get('origin') || 'https://teams.microsoft.com';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

emoticonRouter.post('/emoticon/:emoticon',
										bodyParser.raw({
											limit: '1mb',
											type: 'image/*'
										}), async (req, res) => {
											const data: Buffer = req.body;
											const hexData = data.toString('base64');
											const emojiName = req.params.emoticon;
											try {
												const client = await createClient();
												const emojiIfExists = await client.get(emojiName);
												if (emojiIfExists) {
													res.status(400).send('emoji already exists');
													return;
												}
												await client.set(emojiName, hexData);
												res.status(200).send('successfully inserted emoji ' + emojiName);
											} catch (err) {
												res.status(500).send('Error ' + err);
											}
										});

emoticonRouter.delete('/emoticon/:emoticon', async (req, res) => {
  const emojiName = req.params.emoticon;
  try {
    const client = await createClient();
		client.del(emojiName);
    res.status(200).send('deleted emoji ' + emojiName);
  } catch (err) {
    res.status(500).send('Error ' + err);
  }
});

emoticonRouter.get('/emoticon/:emoticon', async (req, res) => {
  const emoticonName = req.params.emoticon;

	let imageData;
  try {
    const client = await createClient();
    imageData = await client.get(emoticonName);
    if (!imageData) {
      res.status(404).send('not found');
      return;
    }
  } catch (err) {
    res.status(500).send('Error ' + err);
    return;
  }

  res.set('Content-Type', 'image/gif');
  const maxAge = Math.round(60 * 60 * 24 * (15 + (Math.random() * 2 - 1)));
  res.header('Cache-Control', `public, max-age=${maxAge}`);
  res.send(Buffer.from(imageData, 'base64'));
});

emoticonRouter.get('/emoticons', async (req, res) => {
  try {
    const client = await createClient();
		res.send(await client.keys('*'));
  } catch (err) {
    res.status(500).send('Error ' + err);
  }
});
