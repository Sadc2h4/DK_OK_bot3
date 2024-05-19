
import { cwd, env }              from 'process';
import pathToFFmpeg              from 'ffmpeg-static';
env.FFMPEG_PATH = pathToFFmpeg ?? env.FFMPEG_PATH ?? undefined;

import express                   from 'express';
import ffmpeg                    from 'fluent-ffmpeg';
import fs                        from 'fs';
import multer                    from 'multer';
import path                      from 'path';
import unzipper                  from 'unzipper';
import { PassThrough, Readable } from 'stream';
import { getURLVideoID }         from 'ytdl-core';
interface LoopFileNames {
    intro: string,
    loop: string,
    outro: string,
};
interface LoopRequestPayload {
    approx_loop_start?: number,
    approx_loop_end?: number,
    response_to: string,
    url: string,
};
const PORT = 27015;
const PUBLIC_IP = env.PUBLIC_IP;
const GITHUB_PAT = env.GITHUB_PAT;
const app = express();
const upload = multer({ dest: 'LooperOutput/zips/' });
const filenames: Map<string, LoopFileNames> = new Map();
app.use(express.urlencoded({ extended: true }));
app.post('/dk-ok-bot3/loop', upload.single('file'), (req, res) => {
    res.send('');
    if (req.body.error) return;
    if (!req.body.src) return;
    if (!req.file?.path) return;
    let intro: string = '';
    let loop: string = '';
    let outro: string = '';
    const root = path.join(cwd(), 'LooperOutput/loops');
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    console.log(`[POST] Receiving file: ${req.file.path}`);
    fs.createReadStream(req.file.path)
    .pipe(unzipper.Parse()).on('entry', (entry: unzipper.Entry) => {
        console.log(`[FILE] ${entry.path}`);
        const full = path.join(root, entry.path);
        if (entry.path.includes('-intro')) intro = full;
        if (entry.path.includes('-loop'))  loop  = full;
        if (entry.path.includes('-outro')) outro = full;
        entry.pipe(fs.createWriteStream(full));
    }).on('finish', () => {
        console.log('[POST] Finished receiving');
        const id = getURLVideoID(req.body.src);
        filenames.set(id, { intro: intro, loop: loop, outro: outro });
        fs.unlink(req.file?.path ?? '', console.error);
    });
});
app.listen(PORT);
export async function sendLoopRequest(url: string, loop_start?: number, loop_end?: number) {
    const id = getURLVideoID(url);
    if (filenames.get(id)) return;
    const payload: LoopRequestPayload = {
        response_to: `${PUBLIC_IP}:${PORT}/dk-ok-bot3/loop`,
        url: url,
    };
    if (loop_start) payload.approx_loop_start = loop_start;
    if (loop_end) payload.approx_loop_end = loop_end;
    await fetch('https://api.github.com/repos/Sadc2h4/DK_OK_bot3/dispatches', {
        method: "POST",
        headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${GITHUB_PAT}`,
            'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
            'event_type': 'split-audio',
            'client_payload': payload,
        }),
    });
}
export default class LoopPlayer extends Readable {
    url: string;
    available: boolean
    loading?: Promise<void>
    shouldLoop: boolean
    intro?: string
    loop?: string
    outro?: string
    bufferEmpty: Buffer;
    bufferIntro: Buffer[];
    bufferLoop: Buffer[];
    bufferOutro: Buffer[];
    bufferSize: number
    constructor(url: string) {
        super();
        this.url = url;
        this.available = false;
        this.shouldLoop = true;
        this.bufferSize = 1024 * 16;
        this.bufferEmpty = Buffer.alloc(this.bufferSize);
        this.bufferIntro = [];
        this.bufferLoop = [];
        this.bufferOutro = [];
        this.loading = this.load().then(() => { this.loading = undefined; });
    }
    async load() {
        if (this.available) return;
        const id = getURLVideoID(this.url);
        const names = filenames.get(id);
        if (!names) return;
        this.intro = names.intro;
        this.loop = names.loop;
        this.outro = names.outro;
        const bufferIntro = new PassThrough();
        const bufferLoop = new PassThrough();
        const bufferOutro = new PassThrough();
        await Promise.all([
            ffmpeg(this.intro).format('wav').audioCodec('pcm_s16le').writeToStream(bufferIntro),
            ffmpeg(this.loop).format('wav').audioCodec('pcm_s16le').writeToStream(bufferLoop),
            ffmpeg(this.outro).format('wav').audioCodec('pcm_s16le').writeToStream(bufferOutro),
        ]);
        await Promise.all([
            (async (): Promise<void> => {
                for await (const chunk of bufferIntro) this.bufferIntro.push(chunk);
            })(),
            (async (): Promise<void> => {
                for await (const chunk of bufferLoop) this.bufferLoop.push(chunk);
            })(),
            (async (): Promise<void> => {
                for await (const chunk of bufferOutro) this.bufferOutro.push(chunk);
            })(),
        ]);
        this.available = true;
    }
    _read() {
        if (!this.available) {
            this.push(this.bufferEmpty);
            if (!this.loading) {
                this.loading = this.load().then(() => { this.loading = undefined; });
            }
        }
        else if (this.bufferIntro.length > 0) {
            this.push(this.bufferIntro.shift());
        }
        else if (!this.shouldLoop) {
            if (this.bufferOutro.length > 0) {
                this.push(this.bufferOutro.shift());
            }
            else {
                this.push(null);
            }
        }
        else {
            const chunk = this.bufferLoop.shift();
            if (chunk) {
                if (this.shouldLoop) {
                    this.bufferLoop.push(chunk);
                }
                this.push(chunk);
            }
            else {
                this.push(null);
            }
        }
    }
}