
import { cwd, env, platform }    from 'process';
import pathToFFmpeg              from 'ffmpeg-static';
import { GoogleAuth }            from 'google-auth-library';
import ffmpeg                    from 'fluent-ffmpeg';
import fs                        from 'fs';
import path                      from 'path';
import pg                        from 'pg';
import ytdl                      from 'ytdl-core';
import { getYtdlStream }         from './main';
import { Readable, PassThrough } from 'stream';
interface LoopPoints {
    start: number,
    end: number,
}
interface LoopPointsQuery {
    start: number,
    endpos: number,
}
env.FFMPEG_PATH = pathToFFmpeg ?? env.FFMPEG_PATH ?? undefined;
fs.writeFileSync(platform === 'win32'
    ? path.join(cwd(), 'gcp')
    : '/dev/shm/gcp', env.GCP ?? '');
const looppoints = new pg.Pool({ connectionString: env.CONNECTION_STRING });
async function getLoopPoints(id: string): Promise<LoopPoints> {
    const result = await looppoints.query(
        `SELECT start, endpos FROM loop_points WHERE id = '${id}'`);
    if (result.rowCount === null || result.rowCount === 0) return { start: -1, end: -1 };
    const row: LoopPointsQuery = result.rows[0];
    const lp: LoopPoints = { start: row.start, end: row.endpos };
    return (lp.start > 0 && lp.end > 0) ? lp : { start: -1, end: -1 };
}
function setLoopPoints(id: string, start: number, end: number) {
    if (start > 0 && end > 0) {
        looppoints.query(`INSERT INTO loop_points
            VALUES('${id}', ${start}, ${end}) ON CONFLICT(id) DO UPDATE
            SET start = EXCLUDED.start, endpos = EXCLUDED.endpos`)
            .catch(console.error);
    }
}
const loopPlayerInstances: Map<LoopPlayer, true> = new Map();
export async function sendLoopRequest(url: string, loop_start?: number, loop_end?: number) {
    const id = ytdl.getURLVideoID(url);
    const lp = await getLoopPoints(id);
    console.log(lp);
    console.log(`[LOOPER] sendLoopRequest is called for ${id}`);
    if (lp.start < 0 || lp.end < 0) {
        const auth = new GoogleAuth();
        const endpoint = 'https://get-loop-audio-5nluuoku7a-uw.a.run.app';
        const audience = 'https://get-loop-audio-5nluuoku7a-uw.a.run.app';
        const client   = await auth.getIdTokenClient(audience);
        console.log(`[LOOPER] Sending loop point request for ${id}...`);
        client.request<string>({url: `${endpoint}?url=${url}`}).then(async response => {
            console.log(`[LOOPER] Response returned: ${response.data}`);
            const regex = response.data.match(/([\d.]+) ([\d.]+) .*/) ?? [];
            const start = Number.parseFloat(regex[1] ?? '-1');
            const end   = Number.parseFloat(regex[2] ?? '-1');
            setLoopPoints(id, start, end);
            for await (const player of loopPlayerInstances.keys()) {
                player.emit('loopPointsReady', id, start, end);
            }
        }).catch(console.error);
    }
}
export default class LoopPlayer extends Readable {
    url:           string
    id:            string
    is1stTimeLoop: boolean
    loopPoints:    LoopPoints
    loopCount:     number
    fadingOut?:    number
    ffmpegCommand: ffmpeg.FfmpegCommand[]
    ytdlStream:    Readable[]
    buffer:        PassThrough
    bufferSize:    number
    constructor(url: string) {
        super();
        this.url           = url;
        this.id            = ytdl.getURLVideoID(this.url);
        this.is1stTimeLoop = true;
        this.loopPoints    = { start: -1, end: -1 };
        this.loopCount     = 0;
        this.bufferSize    = 65536 * 4;
        this.buffer        = new PassThrough();
        this.ytdlStream    = [];
        this.ffmpegCommand = [];
        getLoopPoints(this.id).then(lp => {
            this.loopPoints = lp;
            this.createFFmpegCommand();
            console.log(`[LOOPER] Looper initialized.`);
            if (!this.loopAvailable()) {
                console.log(`[LOOPER] Loop point is not available, waiting...`);
                this.on('loopPointsReady', this.transitMusic);
                loopPlayerInstances.set(this, true);
                setTimeout(() => {
                    if (loopPlayerInstances.get(this)) loopPlayerInstances.delete(this);
                }, 5 * 60 * 1000);
            }
        });
    }
    transitMusic(id: string, start: number, end: number) {
        if (id !== this.id) return;
        console.log(`[LOOPER] Received event: loopPointsReady for ${id}`);
        loopPlayerInstances.delete(this);
        this.loopPoints = { start, end };
        this.fadingOut = Date.now();
        this.once('fadeOutFinished', () => {
            this.fadingOut = undefined;
            this.createFFmpegCommand(true);
        });
    }
    loopAvailable() {
        return this.loopPoints.start > 0 && this.loopPoints.end > 0;
    }
    createFFmpegCommand(discardRemaining?: true) {
        const old = this.buffer;
        this.buffer = new PassThrough({ highWaterMark: this.bufferSize });
        if (!old.destroyed && old.readableLength > 0) {
            this.buffer.push(discardRemaining ? Buffer.alloc(old.readableLength) : old.read(old.readableLength));
        }

        console.log(`[LOOPER] Loop count: ${++this.loopCount}`);
        this.ytdlStream.shift();
        this.ffmpegCommand.shift();
        if (this.ffmpegCommand.length > 0) {
            this.ffmpegCommand[0].writeToStream(this.buffer)
                .on('finish', () => { this.createFFmpegCommand(); })
                .on('error', console.error);
        }
        getYtdlStream(this.url).then(result => {
            const stream = result[0];
            const cmd = ffmpeg(stream).on('error', console.error)
                .format('wav').audioCodec('pcm_s16le');
            this.ytdlStream.push(stream);
            this.ffmpegCommand.push(cmd);
            if (this.loopAvailable()) {
                const lp       = this.loopPoints;
                const start    = this.is1stTimeLoop ? 0        : lp.start
                const duration = this.is1stTimeLoop ? lp.start : lp.end - lp.start;
                this.is1stTimeLoop = false;
                cmd.setStartTime(start).setDuration(duration);
            }
            if (this.ffmpegCommand.length === 1) {
                this.ffmpegCommand[0].writeToStream(this.buffer)
                    .on('finish', () => { this.createFFmpegCommand(); })
                    .on('error', console.error);
            }
        })
    }
    async _read(size?: number) {
        const length = this.buffer.readableLength;
        size = size ?? this.bufferSize;
        if (this.ffmpegCommand.length === 0) {
            this.push(Buffer.alloc(size));
            return;
        }
        if (length > 0) {
            const buf: Buffer = this.buffer.read(Math.min(size, length));
            if (this.fadingOut) {
                const FADEOUT_DURATION   = 2;
                const TIME_TO_TRANSITION = 3;
                const BYTES_PER_SAMPLE   = 2; // 16-bit signed PCM = 2 bytes per sample
                const t = (Date.now() - this.fadingOut) / 1000;
                const volume = Math.max(0, 1 - t / FADEOUT_DURATION);
                console.log(`[LOOPER] Fading out... t = ${t}, volume = ${volume}`)
                if (t > TIME_TO_TRANSITION) this.emit('fadeOutFinished');
                const n = Math.floor(buf.length / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE;
                for (let i = 0; i < n; i += BYTES_PER_SAMPLE) {
                    const value = Math.floor(volume * buf.readInt16LE(i));
                    buf.writeInt16LE(value, i);
                }
            }
            this.push(buf);
        }
        if (length < size) this.push(Buffer.alloc(size - length));
    }
}
