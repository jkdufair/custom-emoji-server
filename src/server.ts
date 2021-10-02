import express from 'express';
import basicAuth from 'express-basic-auth';

import { emoticonRouter } from './emoticons';

const PORT = process.env.PORT || 5000;
const app = express();

app.get('/', (req, res) => res.send('Hello Emoji Users!!'));

app.use(basicAuth({
	users: {
		'emoji': process.env.EMOJI_USER_PASSWORD
	}
}));

app.use('/', emoticonRouter);

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
