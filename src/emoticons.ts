import * as bodyParser from 'body-parser';
import express from 'express';
import { createNodeRedisClient as createClient } from 'handy-redis';
import { BlobServiceClient } from '@azure/storage-blob';

export const emoticonRouter = express.Router();

const redisConnectionOptions = !process.env.REDIS_CONNECTION_STRING ? {} : {'url': process.env.REDIS_CONNECTION_STRING};

const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
const containerClient = blobServiceClient.getContainerClient('emojis');


emoticonRouter.use((_, res, next) => {
  const origin = res.get('origin') || 'https://teams.microsoft.com';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

emoticonRouter.post('/emoticon/:emoticon', bodyParser.raw({
	limit: '1mb',
	type: 'image/*'
}), async (req, res) => {
	const data: Buffer = req.body;
	const hexData = data.toString('hex');
	const split = req.params.emoticon.split('.');
	const emojiName = split[0];
	let emojiExtension = split[1];
	try {
		const client = createClient(redisConnectionOptions);
		const emoji = await client.get(emojiName);
		if (emoji) {
			res.status(400).send('emoji already exists');
			return;
		}
		await client.hmset(emojiName, ['extension', emojiExtension], ['data', hexData]);
		res.status(200).send('successfully inserted emoji ' + emojiName);
	} catch (err) {
		res.status(500).send('Error ' + err);
	}
});

emoticonRouter.delete('/emoticon/:emoticon', async (req, res) => {
  const emojiName = req.params.emoticon;
  try {
    const client = createClient(redisConnectionOptions);
		client.del(emojiName);
    res.status(200).send('deleted emoji ' + emojiName);
  } catch (err) {
    res.status(500).send('Error ' + err);
  }
});

emoticonRouter.get('/emoticon/:emoticon', async (req, res) => {
  const emoticonName = req.params.emoticon;

	let extension;
	let imageData;
  try {
    const client = createClient(redisConnectionOptions);
    const hash = await client.hgetall(emoticonName);
    if (!hash) {
      res.status(404).send('not found');
      return;
    }
		extension = hash["extension"];
		if (extension === 'jpg') extension = 'jpeg';
		imageData = hash["data"];
  } catch (err) {
    res.status(500).send('Error ' + err);
    return;
  }

  res.set('Content-Type', `image/${extension}`);
  const maxAge = Math.round(60 * 60 * 24 * (15 + (Math.random() * 2 - 1)));
  res.header('Cache-Control', `public, max-age=${maxAge}`);
  res.send(Buffer.from(imageData, 'hex'));
});

emoticonRouter.get('/emoticons', async (_, res) => {
  try {
    const client = createClient(redisConnectionOptions);
		res.send(await client.keys('*'));
  } catch (err) {
    res.status(500).send('Error ' + err);
  }
});

emoticonRouter.get('/emoticon-blobs', async (_, res) => {
	let blobNames=[]
	// List the blob(s) in the container.
	for await (const blob of containerClient.listBlobsFlat()) {
		blobNames.push(blob.name);
	}
	res.send(blobNames);
})

// [Node.js only] A helper method used to read a Node.js readable stream into a Buffer
async function streamToBuffer(readableStream: NodeJS.ReadableStream) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    readableStream.on("data", (data) => {
      chunks.push(data instanceof Buffer ? data : Buffer.from(data));
    });
    readableStream.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    readableStream.on("error", reject);
  });
}

emoticonRouter.post('/init', async (_, res) => {
  const client = createClient(redisConnectionOptions);
  const hash = await client.hgetall('slackbot');
	// If redis is empty, load it up with all the emojis from storage
  if (!hash) {
		let createdBlobs: string[] = [];
		for await (const blob of containerClient.listBlobsFlat()) {
			createdBlobs.push(blob.name);

			const split = blob.name.split('.');
			const emojiName = split[0];
			let emojiExtension = split[1];

			const blobClient = containerClient.getBlobClient(blob.name);
			const downloadBlockBlobResponse = await blobClient.download();
			const hexData = (
				await streamToBuffer(downloadBlockBlobResponse.readableStreamBody)
			).toString('hex');

			await client.hmset(emojiName, ['extension', emojiExtension], ['data', hexData]);
			console.log(`Saved ${emojiName}`);
		}
		res.status(201).send(createdBlobs);
  } else {
		res.sendStatus(304);
	}
})
