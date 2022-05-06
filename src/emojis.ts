// TODO handle exceptions in middleware
import * as bodyParser from 'body-parser';
import express from 'express';
import { createNodeRedisClient as createRedisClient } from 'handy-redis';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import NodeCache from 'node-cache';

export const emojiRouter = express.Router();
const redisConnectionOptions = !process.env.REDIS_CONNECTION_STRING ? {} : { 'url': process.env.REDIS_CONNECTION_STRING };
const azureStorageConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const blobServiceClient = BlobServiceClient.fromConnectionString(azureStorageConnectionString);
// 24px high blobs
const containerClient24 = blobServiceClient.getContainerClient('emojis24');
// 36px high blobs
const containerClient36 = blobServiceClient.getContainerClient('emojis36');
// 48px high blobs
const containerClient48 = blobServiceClient.getContainerClient('emojis48');
// full size blobs
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
		const size = req.query.s
		if (size === '') {
			res.status(500).send('Size (s) query param required (24, 36, 48)');
		}
		const hexData = data.toString('hex');
		const filename = req.params.emoji;
		const { name, extension } = nameParts(filename);

		if (!name || !extension) {
			res.status(500).send('Name and extension required');
			return;
		}

		const key = `${name}:${size}`;
		const emoji = await redisClient.get(key);
		if (emoji) {
			res.status(400).send('emoji already exists');
			return;
		}

		let containerClient: ContainerClient;
		// upload to blob container first so it's persisted
		switch (size) {
			case '24':
				containerClient = containerClient24;
				break;
			case '36':
				containerClient = containerClient36;
				break;
			case '48':
				containerClient = containerClient48;
				break;
			default:
				containerClient = containerClient24;
				break;
		}

		const blobClient = containerClient.getBlockBlobClient(filename);
		await blobClient.upload(data, data.length);

		// then to redis for serving up hot & fresh
		await redisClient.hmset(key, ['extension', extension], ['data', hexData]);
		res.status(200).send(`successfully inserted emoji with size ${size}: ${name}`);
	} catch (err) {
		res.status(500).send('Error ' + err);
	}
});

emojiRouter.delete('/emoji/:emoji', async (req, res) => {
	try {
		const emojiName = req.params.emoji;
		const key = `${emojiName}:24`;

		// Get the hash from redis so we have the file extension
		const hash = await redisClient.hgetall(key);

		// delete from blob container first so it's gone, gone, gone
		const filename = `${emojiName}.${hash["extension"]}`
		const blobClient24 = containerClient24.getBlockBlobClient(filename);
		await blobClient24.deleteIfExists();
		const blobClient36 = containerClient36.getBlockBlobClient(filename);
		await blobClient36.deleteIfExists();
		const blobClient48 = containerClient48.getBlockBlobClient(filename);
		await blobClient48.deleteIfExists();

		// then from redis
		redisClient.del(`${emojiName}:24`);
		redisClient.del(`${emojiName}:36`);
		redisClient.del(`${emojiName}:48`);
		res.status(200).send('deleted emoji ' + key);
	} catch (err) {
		res.status(500).send('Error ' + err);
	}
});

emojiRouter.get('/emoji/:emoji', async (req, res) => {
	try {
		const emojiName = req.params.emoji;
		let size = req.query.s;
		if (size == null || size === '') {
			size = 'full'
		}		
		const key = `${emojiName}:${size}`;

		let hash: Record<string, string>;
		const cachedHash: Record<string, string> = nodeCache.get(key);
		if (cachedHash) {
			hash = cachedHash;
		}
		else {
			hash = await redisClient.hgetall(key);
			if (!hash) {
				res.status(404).send('not found');
				return;
			}
			nodeCache.set(key, hash);
		}

		let extension = hash["extension"];
		if (extension === 'jpg') extension = 'jpeg';
		const imageData = hash.data;

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
		const keys = await redisClient.keys('*:24');
		res.send(keys.map(k => k.substring(0, k.length - 3)));
	} catch (err) {
		res.status(500).send('Error ' + err);
	}
});

emojiRouter.get('/emoji-blobs', async (_, res) => {
	let blobNames = []
	// List the blob(s) in the container.
	for await (const blob of containerClient24.listBlobsFlat()) {
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

export const init = async () => {
	try {
		// Sentinel emoji - if it's there, we are assuming they're all there
		const hash = await redisClient.hgetall('slackbot:24');

		// If redis is empty, load it up with all the emojis from storage
		if (!hash) {
			let createdBlobs: string[] = [];
			for await (const blob of containerClient24.listBlobsFlat()) {
				createdBlobs.push(blob.name);

				const { name, extension } = nameParts(blob.name)

				const blobClient = containerClient24.getBlobClient(blob.name);
				const downloadBlockBlobResponse = await blobClient.download();
				const hexData = (
					await streamToBuffer(downloadBlockBlobResponse.readableStreamBody)
				).toString('hex');

				console.log('/init loading 24x24: ', blob.name)

				await redisClient.hmset(`${name}:24`, ['extension', extension], ['data', hexData]);
			}
			for await (const blob of containerClient36.listBlobsFlat()) {
				const { name, extension } = nameParts(blob.name)

				const blobClient = containerClient36.getBlobClient(blob.name);
				const downloadBlockBlobResponse = await blobClient.download();
				const hexData = (
					await streamToBuffer(downloadBlockBlobResponse.readableStreamBody)
				).toString('hex');

				console.log('/init loading 36x36: ', blob.name)

				await redisClient.hmset(`${name}:36`, ['extension', extension], ['data', hexData]);
			}
			for await (const blob of containerClient48.listBlobsFlat()) {
				const { name, extension } = nameParts(blob.name)

				const blobClient = containerClient48.getBlobClient(blob.name);
				const downloadBlockBlobResponse = await blobClient.download();
				const hexData = (
					await streamToBuffer(downloadBlockBlobResponse.readableStreamBody)
				).toString('hex');

				console.log('/init loading 48x48: ', blob.name)

				await redisClient.hmset(`${name}:48`, ['extension', extension], ['data', hexData]);
			}
			for await (const blob of containerClient.listBlobsFlat()) {
				const { name, extension } = nameParts(blob.name)

				const blobClient = containerClient.getBlobClient(blob.name);
				const downloadBlockBlobResponse = await blobClient.download();
				const hexData = (
					await streamToBuffer(downloadBlockBlobResponse.readableStreamBody)
				).toString('hex');

				console.log('/init loading full size: ', blob.name)

				await redisClient.hmset(`${name}:full`, ['extension', extension], ['data', hexData]);
			}
			return {
				status: 201,
				body: createdBlobs
			}
		} else {
			return {
				status: 304
			}
		}
	} catch (err) {
		return {
			status: 304,
			body: `Error ${err}`
		}
	}
}

emojiRouter.post('/init', async () => {
	// TODO handle errors
	await init()
})
