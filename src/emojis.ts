// TODO handle exceptions in middleware
import * as bodyParser from 'body-parser';
import express from 'express';
import { createNodeRedisClient as createRedisClient } from 'handy-redis';
import { BlobServiceClient } from '@azure/storage-blob';
import NodeCache from 'node-cache';

export const emojiRouter = express.Router();
const redisConnectionOptions = !process.env.REDIS_CONNECTION_STRING ? {} : { 'url': process.env.REDIS_CONNECTION_STRING };
const azureStorageConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const blobServiceClient = BlobServiceClient.fromConnectionString(azureStorageConnectionString);
const containerClient = blobServiceClient.getContainerClient('emojis');
const nodeCache = new NodeCache();
const redisClient = createRedisClient(redisConnectionOptions);

emojiRouter.use((_, res, next) => {
	const origin = res.get('origin') || 'https://teams.microsoft.com';
	res.header('Access-Control-Allow-Origin', origin);
	res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
	next();
});

const nameParts = (emojiFilename: string) => {
	const split = emojiFilename.split('.');
	return { name: split[0], extension: split[1] };
}

emojiRouter.post('/emoji/:emoji', bodyParser.raw({
	limit: '1mb',
	type: 'image/*'
}), async (req, res) => {
	try {
		const data: Buffer = req.body;
		const hexData = data.toString('hex');
		const filename = req.params.emoji;
		const { name, extension } = nameParts(filename);

		if (!name || !extension) {
			res.status(500).send('Name and extension required');
			return;
		}

		const emoji = await redisClient.get(name);
		if (emoji) {
			res.status(400).send('emoji already exists');
			return;
		}

		// upload to blob container first so it's persisted
		const blobClient = containerClient.getBlockBlobClient(filename);
		await blobClient.upload(data, data.length);

		// then to redis for serving up hot & fresh
		await redisClient.hmset(name, ['extension', extension], ['data', hexData]);
		res.status(200).send('successfully inserted emoji ' + name);
	} catch (err) {
		res.status(500).send('Error ' + err);
	}
});

emojiRouter.delete('/emoji/:emoji', async (req, res) => {
	try {
		const emojiName = req.params.emoji;

		// Get the hash from redis so we have the file extension
		const hash = await redisClient.hgetall(emojiName);

		// delete from blob container first so it's gone, gone, gone
		const blobClient = containerClient
			.getBlockBlobClient(`${req.params.emoji}.${hash["extension"]}`);
		await blobClient.deleteIfExists();

		// then from redis
		redisClient.del(emojiName);
		res.status(200).send('deleted emoji ' + emojiName);
	} catch (err) {
		res.status(500).send('Error ' + err);
	}
});

emojiRouter.get('/emoji/:emoji', async (req, res) => {
	try {
		const emojiName = req.params.emoji;

		let extension;
		let imageData;
		let hash: Record<string, string>;
		const cachedHash: Record<string, string> = nodeCache.get(emojiName);
		if (cachedHash) {
			hash = cachedHash;
		}
		else {
			hash = await redisClient.hgetall(emojiName);
			if (!hash) {
				res.status(404).send('not found');
				return;
			}
			nodeCache.set(emojiName, hash);
			redisClient.quit();
		}

		extension = hash["extension"];
		if (extension === 'jpg') extension = 'jpeg';
		imageData = hash.data;

		res.set('Content-Type', `image/${extension}`);
		// not sure about this algorithm - 15 ± 1 day???
		const maxAge = Math.round(60 * 60 * 24 * (15 + (Math.random() * 2 - 1)));
		res.header('Cache-Control', `public, max-age=${maxAge}`);
		res.send(Buffer.from(imageData, 'hex'));
	} catch (err) {
		res.status(500).send('Error ' + err);
		return;
	}
});

emojiRouter.get('/emojis', async (_, res) => {
	try {
		res.send(await redisClient.keys('*'));
	} catch (err) {
		res.status(500).send('Error ' + err);
	}
});

emojiRouter.get('/emoji-blobs', async (_, res) => {
	let blobNames = []
	// List the blob(s) in the container.
	for await (const blob of containerClient.listBlobsFlat()) {
		blobNames.push(blob.name);
	}
	res.send(blobNames);
})

//A helper method used to read a Node.js readable stream into a Buffer
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

emojiRouter.post('/init', async (_, res) => {
	try {
		// Sentinel emoji - if it's there, we are assuming they're all there
		const hash = await redisClient.hgetall('slackbot');

		// If redis is empty, load it up with all the emojis from storage
		if (!hash) {
			let createdBlobs: string[] = [];
			for await (const blob of containerClient.listBlobsFlat()) {
				createdBlobs.push(blob.name);

				const { name, extension } = nameParts(blob.name)

				const blobClient = containerClient.getBlobClient(blob.name);
				const downloadBlockBlobResponse = await blobClient.download();
				const hexData = (
					await streamToBuffer(downloadBlockBlobResponse.readableStreamBody)
				).toString('hex');

				console.log('/init loading: ', blob.name)

				await redisClient.hmset(name, ['extension', extension], ['data', hexData]);
			}
			res.status(201).send(createdBlobs);
		} else {
			res.sendStatus(304);
		}
	} catch (err) {
		res.status(500).send('Error ' + err)
	}

})
