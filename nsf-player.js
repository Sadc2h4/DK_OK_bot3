
const libgme = require('./libgme');
const { Readable } = require('stream');
const { OpusEncoder } = require('@discordjs/opus');

libgme.run();
class NsfPlayer extends Readable {
	constructor(nsfBuffer, trackNumber, options) {
		super(options);
        this.nsfBuffer = nsfBuffer;
        this.nsfArray = new Uint8Array(this.nsfBuffer.buffer);
        this.trackNumber = trackNumber;
        this.ref = libgme.allocate(1, 'i32', libgme.ALLOC_STATIC);
        this.sampleRate = 48000;
        if (libgme.ccall('gme_open_data',
            'number', ['array', 'number', 'number', 'number'],
            [this.nsfArray, this.nsfArray.length, this.ref, this.sampleRate]) != 0) {
            console.error('gme_open_data failed.');
            throw "Failed to open NSF!";
        }
        this.encoder = new OpusEncoder(this.sampleRate, 2);
        this.emu = libgme.getValue(this.ref, 'i32');
        const track_count = libgme.ccall('gme_track_count', 'number', ['number'], [this.emu]);
        const voice_count = libgme.ccall('gme_voice_count', 'number', ['number'], [this.emu]);
        console.log('Channel count: ', voice_count);
        console.log('Track count: ', track_count);
        // libgme.ccall('gme_ignore_silence', 'number', ['number'], [this.emu, 1]);
        if (libgme.ccall('gme_start_track',
            'number', ['number', 'number'], [this.emu, trackNumber]) != 0) {
            console.error('Failed to load track.');
            throw "Failed to load track!";
        }
        this.bufferSize = 1024 * 16;
        this.buffer = libgme.allocate(this.bufferSize * 2, 'i32', libgme.ALLOC_STATIC);
        this.jsbuffer = Buffer.alloc(this.bufferSize * 2 * 2);
        this.INT16_MAX = Math.pow(2, 32) - 1;
	}
	_read() {
        if (libgme.ccall('gme_track_ended', 'number', ['number'], [this.emu]) == 1) {
            this.push(null);
            console.log('End of stream.');
            return;
        }
        
        const numChannels = 2;
        const _ = libgme.ccall('gme_play',
            'number', ['number', 'number', 'number'],
            [this.emu, this.bufferSize * 2, this.buffer]);
        for (let i = 0; i < this.bufferSize; i++) {
            for (let n = 0; n < numChannels; n++) {
                const offset = this.buffer + i * numChannels * 2 + n * 4;
                const sample = libgme.getValue(offset, 'i32') / this.INT16_MAX;
                const sampleInt = sample * 32767;
                this.jsbuffer.writeInt16LE(sampleInt, (i * numChannels + n) * 2);
            }
        }
        
        this.push(this.jsbuffer);
        // const encoded = this.encoder.encode(this.jsbufer);
        // this.push(encoded);
	}
}

module.exports = NsfPlayer;
