
const request = require('request');
const NsfPlayer = require('./nsf-player');
// Renderに置く場合、HTTPリクエストを何か処理できる能力がないとダメらしい
const express = require('express');
const app = express();
const port = process.env.PORT || 3001;
app.get("/", (_, res) => res.type('html').send('<h1>DK OK &#x1F4AA;&#x1F98D;</h1>\n'));
app.listen(port, () => console.log(`DK OK bot is listening on port ${port}!`));

const ytpl      = require('ytpl');
const ytdl      = require('ytdl-core');
const Discord   = require('discord.js');
const { parse, URL } = require("url");
const {
	AudioPlayerStatus,
	StreamType,
	createAudioPlayer,
	createAudioResource,
	entersState,
	getVoiceConnection,
	joinVoiceChannel,
} = require('@discordjs/voice');
const {
	ApplicationCommandType,
	ApplicationCommandOptionType,
} = require("discord.js");
const { createReadStream } = require('fs');
const { Stream } = require('stream');

const queue = new Map();         // Song queue
const subscriptions = new Map(); // Audio subscriptions
const functionTable = new Map();
const client = new Discord.Client({
	intents: [
		Discord.IntentsBitField.Flags.Guilds,
		Discord.IntentsBitField.Flags.GuildMessages,
		Discord.IntentsBitField.Flags.GuildMessageTyping,
		Discord.IntentsBitField.Flags.GuildVoiceStates,
		Discord.GatewayIntentBits.MessageContent
	]
});

// URLにパラメータfieldがあるかどうかを返す
function parameterExists(url, field) {
	return url.indexOf(`?${field}=`) != -1 || url.indexOf(`&${field}=`) != -1;
}

// Milliseconds → "HH:MM:SS"
function formatTime(ms) {
	const str = new Date(ms).toISOString();
	if (ms < 3600000) return str.substring(14, 19);
	return str.substring(11, 19);
}

// 再生キューをシャッフルする
function shuffle(interaction, gag) {
	const serverQueue = queue.get(interaction.guild.id);
	if (!serverQueue) return;

	const songs = serverQueue.songs;
	if (!songs) return;

	const firstSong = songs[0];
	for (let i = songs.length - 1; i >= 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[songs[i], songs[j]] = [songs[j], songs[i]];
	}

	// 現在再生中の場合、先頭の曲は再生が終わると消されるので元と同じにする
	const ss = subscriptions.get(interaction.guild.id);
	if (ss?.player) {
		console.log(ss.player.status);
		const currentPlaying = songs.indexOf(firstSong);
		[songs[0], songs[currentPlaying]] = [songs[currentPlaying], songs[0]];
	}

	if (gag) return;
	interaction.editReply("Shuffled the queue!");
	setTimeout(() => { interaction.deleteReply(); }, 1000 * 5);
}

// 再生キューから曲を取り出し再生する。再生が終わるとキューから消去される。
async function play(guild, song) {
	const serverQueue = queue.get(guild.id);
	const interaction = song.interaction;
	const connection = getVoiceConnection(guild.id);
	if (!song) return;

	// [Workaround!!]
	// https://github.com/discordjs/discord.js/issues/9185#issuecomment-1452514375
	connection.on('stateChange', (before, after) => {
		const oldNetworking = Reflect.get(before, 'networking');
		const newNetworking = Reflect.get(after, 'networking');
		const networkStateChangeHandler = (_, newNetworkState) => {
			const newUdp = Reflect.get(newNetworkState, 'udp');
			clearInterval(newUdp?.keepAliveInterval);
		}

		oldNetworking?.off('stateChange', networkStateChangeHandler);
		newNetworking?.on('stateChange', networkStateChangeHandler);
	});

	try {
		// https://scrapbox.io/discordjs-japan/ytdl-core_を使用して_YouTube_の音源を配信するサンプル
		const audioPlayer = createAudioPlayer();
		subscriptions.set(guild.id, connection.subscribe(audioPlayer));
		
		if (song.chiptune) {
			const player = new NsfPlayer(song.chiptune, song.trackNumber || 0);
			const resource = createAudioResource(player, { inputType: StreamType.Raw });
			audioPlayer.addListener("stateChange", (_, after) => {
				console.log(`[Player status] ${_.status} -> ${after.status}`);
				if (after.status !== "idle" && after.status !== "autopaused") return;
				serverQueue.songs?.shift();
				if (serverQueue.songs.length > 0) {
					play(guild, serverQueue.songs[0]);
				}
				else {
					queue.delete(guild.id);
					subscriptions.delete(guild.id);
				}
			});
			audioPlayer.play(resource);
			await entersState(audioPlayer, AudioPlayerStatus.Playing, 10 * 1000);
			await entersState(audioPlayer, AudioPlayerStatus.Idle, 24 * 60 * 60 * 1000);
			return;
		}
		else if (song.rawurl) {
			const resource = createAudioResource(song.rawurl, { type: StreamType.Arbitrary });
			audioPlayer.addListener("stateChange", (_, after) => {
				console.log(`[Player status] ${_.status} -> ${after.status}`);
				if (after.status !== "idle" && after.status !== "autopaused") return;
				serverQueue.songs?.shift();
				if (serverQueue.songs.length > 0) {
					play(guild, serverQueue.songs[0]);
				}
				else {
					queue.delete(guild.id);
					subscriptions.delete(guild.id);
				}
			});
			audioPlayer.play(resource);
			await entersState(audioPlayer, AudioPlayerStatus.Playing, 10 * 1000);
			await entersState(audioPlayer, AudioPlayerStatus.Idle, 24 * 60 * 60 * 1000);
			return;
		}
		const videoID = ytdl.getURLVideoID(song.url);
		const info = await ytdl.getInfo(song.url);
		let type = StreamType.WebmOpus;
		let filter = filter => filter.audioCodec === "opus" && filter.container === "webm";
		const formats = ytdl.filterFormats(info.formats, filter);
		if (formats.length === 0) [type, filter] = [StreamType.Arbitrary, "audio"];
		const stream = ytdl(videoID, {
			highWaterMark: 32 * 1024 * 1024,
			quality: "lowestaudio",
			filter: filter
		});
		
		const prefix = `**${song.title}** \n\`${song.url}\``;
		const duration = formatTime(info.videoDetails.lengthSeconds * 1000);
		const resource = createAudioResource(stream, { inputType: type });
		const title = await interaction.channel.send(prefix);
		const initTime = duration > info.videoDetails.lengthSeconds * 60 * 60 ? "00:00:00" : "00:00";
		const message = await interaction.channel.send(`\`${initTime} / ${duration}\``);
		const id = setInterval(() => {
			const current = resource.playbackDuration;
			message.edit(`\`${formatTime(current)} / ${duration}\``).catch(console.error);
		}, 1000);
		audioPlayer.addListener("stateChange", (_, after) => {
			console.log(`[Player status] ${_.status} -> ${after.status}`);
			if (after.status !== "idle" && after.status !== "autopaused") return;
			clearInterval(id);
			message.delete();
			title.delete();
			serverQueue.songs?.shift();
			if (serverQueue.songs.length > 0) {
				play(guild, serverQueue.songs[0]);
			}
			else {
				queue.delete(guild.id);
				subscriptions.delete(guild.id);
			}
		});
		
		audioPlayer.play(resource); // 再生
		await entersState(audioPlayer, AudioPlayerStatus.Playing, 10 * 1000);
		await entersState(audioPlayer, AudioPlayerStatus.Idle, 24 * 60 * 60 * 1000);
	}
	catch (error) {
		console.error(error);
	}
}

// 曲を再生キューに追加する
// bool gag: チャットを送らない。プレイリスト内の曲を追加する時にうるさいので使う
// bool insertNext: キューの2番めに追加して、次に再生する曲とする
function pushQueue(interaction, song, gag, insertNext) {
	const serverQueue = queue.get(interaction.guild.id);
	const connection = getVoiceConnection(interaction.guild.id);
	if (!connection) {
		try {
			// Here we try to join the voicechat and save our connection into our object.
			joinVoiceChannel({
				channelId: interaction.member.voice.channel.id,
				guildId: interaction.guild.id,
				adapterCreator: interaction.guild.voiceAdapterCreator
			})
		} catch (err) {
			// Printing the error message if the bot fails to join the voicechat
			console.log(err);
			console.log("error at joinning VC");
			queue.delete(interaction.guild.id);
			return;
		}
	}

	if (!serverQueue) {
		// Creating the contract for our queue
		const queueContruct = {
			songs: [],
			volume: 5,
			playing: true,
		};
	   
		queue.set(interaction.guild.id, queueContruct); // Setting the queue using our contract
		queueContruct.songs.push(song); // Pushing the song to our songs array
	}
	else {
		if (!serverQueue.songs) serverQueue.songs = [];
		if (insertNext && serverQueue.songs.length > 1) {
			serverQueue.songs.splice(1, 0, song);
		}
		else {
			serverQueue.songs.push(song);
		}
	}
	if (gag) return;
	return interaction.editReply(`**${song.title}** has been added to the queue!`);
}
async function startPlaying(interaction, playLater) {
	try {
		// Calling the play function to start a song
		const serverQueue = queue.get(interaction.guild.id);
		const ss = subscriptions.get(interaction.guild.id);
		if (!serverQueue) return;
		if (ss?.player) {
			if (playLater) return;
			return ss.player.stop();
		}
		else {
			play(interaction.guild, serverQueue.songs[0]);
		}
	}
	catch (error) {
		console.error("Error at playing a song");
		console.error(error);
		return await interaction.editReply("Failed to play a song!");
	}
}

functionTable.set("shuffle", shuffle);
functionTable.set("play", async function(interaction) { // !playのパラメータ解析と曲の追加 → 再生
	setTimeout(() => { interaction.deleteReply(); }, 1000 * 5);
	const voiceChannel = interaction.member.voice.channel;
	const permissions = voiceChannel?.permissionsFor(interaction.client.user);
	if (!voiceChannel) {
		return await interaction.editReply("You need to be in a voice channel to play music!");
	}
	if (!permissions?.has(Discord.PermissionsBitField.Flags.Connect)
	||  !permissions?.has(Discord.PermissionsBitField.Flags.Speak)) {
		return await interaction.editReply("I need the permissions to join and speak in your voice channel!");
	}

	// optionの解析
	let url = interaction.options.getString('url');
	const isdropbox = url.includes("dropbox.com");
	const shortened = url.includes("youtu.be");
	const aux = interaction.options.getString('option');
	const keywords = ["shuffle", "next", "now"];
	
	// URLが与えられている時
	if (shortened) {
		const parsed = new URL(url);
		const id = parsed.pathname.replace(/\//g, "");
		url = `https://www.youtube.com/watch?v=${id}`;
	}
	else if (isdropbox) {
		const parsed = new URL(url);
		parsed.searchParams.set("raw", "1");
		pushQueue(interaction, {
			interaction: interaction,
			title: "Dropbox",
			rawurl: parsed.toString(),
		}, false, aux === keywords[1] || aux === keywords[2]);
	}
	const validVideo = parameterExists(url, "v")     || ytdl.validateID(url);
	const validList = !parameterExists(url, "index") && ytpl.validateID(url);
	if (validList) { // プレイリストの追加
		try {
			const pl = await ytpl(url, { limit: Infinity });
			pl.items.forEach(i => {
				pushQueue(interaction, {
					interaction: interaction,
					title: i.title,
					url: i.shortUrl,
				}, true, aux === keywords[1] || aux == keywords[2]);
			});

			await interaction.editReply("Added a playlist to the queue!");
			if (aux == keywords[0]) shuffle(interaction, true);
		}
		catch (error) {
			console.error(error);
			return await interaction.editReply("I can't fetch playlist info!");
		}
	}
	else if (validVideo) { // 曲の追加
		try {
			const songInfo = await ytdl.getInfo(url);
			await pushQueue(interaction, {
				interaction: interaction,
				title: songInfo.videoDetails.title,
				url: songInfo.videoDetails.video_url,
			}, false, aux === keywords[1] || aux === keywords[2]);
		}
		catch (error) {
			console.error(error);
			return await interaction.editReply("I can't fetch video info!");
		}
	}
	startPlaying(interaction, aux !== keywords[2]);
});
functionTable.set("skip", function(interaction) { // 現在再生中の曲をスキップして次の曲を流す
	const ss = subscriptions.get(interaction.guild.id);
	if (!ss?.player) return;
	ss.player.stop();
	interaction.deleteReply();
});
functionTable.set("stop", function(interaction) { // 曲の再生を止め、再生キューを消去し、VCから抜ける
	const connection = getVoiceConnection(interaction.guild.id);
	const serverQueue = queue.get(interaction.guild.id);
	const ss = subscriptions.get(interaction.guild.id);
	if (ss?.player) {
		ss.player.stop();
		ss.player.emit("stateChange", "", "idle");
	}
	if (connection) connection.destroy();
	if (serverQueue) queue.delete(interaction.guild.id);
	if (ss) subscriptions.delete(interaction.guild.id);
	interaction.deleteReply();
});
functionTable.set("clear", function(interaction) { // 再生キューを全消去する
	const serverQueue = queue.get(interaction.guild.id);
	if (!serverQueue) return;
	serverQueue.songs = undefined;
	interaction.deleteReply();
});
functionTable.set("queue", function(interaction) { // 再生キューをチャットに表示する
	const MaxSongsToShow = 15;                     // 多すぎると送れないので15件まで出る
	const serverQueue = queue.get(interaction.guild.id);
	const songs = serverQueue?.songs;
	if (!songs || songs.length == 0) {
		interaction.editReply("No queue here!");
		setTimeout(() => { interaction.deleteReply(); }, 1000 * 5);
		return;
	}

	let msg = "Queue:\n";
	for (let i = 0; i < songs.length; ++i) {
		msg += `  ${i + 1}. **${songs[i].title}**\n`
		if (i > MaxSongsToShow) {
			msg += "  ...";
			break;
		}
	}
	interaction.editReply(msg);
	setTimeout(() => { interaction.deleteReply(); }, 1000 * 30);
});
functionTable.set("upnext", function(interaction) { // 次の曲を表示する
	const serverQueue = queue.get(interaction.guild.id);
	const songs = serverQueue?.songs;
	if (!songs || songs.length < 2) {
		interaction.editReply("No song to play next!");
	}
	else {
		interaction.editReply(`Up next ~ **${songs[1].title}**\n${songs[1].url}`);
	}
	setTimeout(() => { interaction.deleteReply(); }, 1000 * 5);
});
functionTable.set("chiptune", async function(interaction) { // NSFを再生する
	setTimeout(() => { interaction.deleteReply(); }, 1000 * 5);
	const att = interaction.options.getAttachment('chiptune');
	const aux = interaction.options.getString('option');
	const track = interaction.options.getInteger('track');
	const keywords = ["shuffle", "next", "now"];
	const req = request.defaults({ encoding: null });
	req.get(att.url, (error, response, body) => {
		if (error || response.statusCode !== 200) {
			console.error("Failed to load NSF", error, response.statusCode);
			return interaction.editReply("Failed to load NSF!");
		}
		pushQueue(interaction, {
			interaction: interaction,
			chiptune: body,
			trackNumber: track,
			title: "NSF",
		}, false, aux === keywords[1] || aux === keywords[2]);
		startPlaying(interaction, aux !== keywords[2]);
	});
});
client.on('interactionCreate', async interaction => {
	await interaction.reply('｡ﾟ(ﾟ´ω`ﾟ)ﾟ｡');
	if (!interaction.isCommand()) return;
	const cmd = interaction.commandName;
	const cmdMatch = [...functionTable.keys()].filter(c => c === cmd);
	if (cmdMatch.length > 0) return functionTable.get(cmdMatch[0])?.(interaction);
});

client.on("ready", async () => {
    console.log(`${client.user.tag} has logged in.`);
	client.user.setActivity(`/help | ${client.user.username}`, { type: "PLAYING" });
	await client.application.commands.set([
		{
			'name': 'play',
			'type': ApplicationCommandType.ChatInput,
			'description': 'YouTubeのURLを指定してプレイリストに追加します。',
			'options': [
				{
					'name': 'url',
					'description': 'YouTubeのURL。プレイリストのURLを指定することも可能。',
					'type': ApplicationCommandOptionType.String,
					'required': false,
				},
				{
					'name': 'option',
					'description': '追加のオプション。',
					'type': ApplicationCommandOptionType.String,
					'required': false,
					'choices': [
						{
							'name': '今すぐ再生',
							'value': 'now',
						},
						{
							'name': 'シャッフル再生',
							'value': 'shuffle',
						},
						{
							'name': '次に再生',
							'value': 'next',
						}
					],
				},
			],
		},
		{
			'name': 'skip',
			'type': ApplicationCommandType.ChatInput,
			'description': '現在再生中の曲をスキップします。',
		},
		{
			'name': 'stop',
			'type': ApplicationCommandType.ChatInput,
			'description': '再生を停止し、プレイリストを消去し、ボイスチャンネルから切断します。',
		},
		{
			'name': 'clear',
			'type': ApplicationCommandType.ChatInput,
			'description': 'プレイリストを消去します。',
		},
		{
			'name': 'shuffle',
			'type': ApplicationCommandType.ChatInput,
			'description': 'プレイリストをシャッフルします。',
		},
		{
			'name': 'queue',
			'type': ApplicationCommandType.ChatInput,
			'description': 'プレイリストを表示します。',
		},
		{
			'name': 'upnext',
			'type': ApplicationCommandType.ChatInput,
			'description': '次に再生する曲を表示します。',
		},
		{
			'name': 'chiptune',
			'type': ApplicationCommandType.ChatInput,
			'description': 'NSF, SPC, GBSファイルをプレイリストに追加します。',
			'options': [
				{
					'name': 'chiptune',
					'description': 'NSF, SPC, GBSファイル。',
					'type': ApplicationCommandOptionType.Attachment,
					'required': true,
				},
				{
					'name': 'track',
					'description': 'NSF, SPC, GBSファイルのトラック番号。0から始まる。',
					'type': ApplicationCommandOptionType.Integer,
					'min_value': 0,
					'required': false,
				},
				{
					'name': 'option',
					'description': '追加のオプション。',
					'type': ApplicationCommandOptionType.String,
					'required': false,
					'choices': [
						{
							'name': '今すぐ再生',
							'value': 'now',
						},
						{
							'name': 'シャッフル再生',
							'value': 'shuffle',
						},
						{
							'name': '次に再生',
							'value': 'next',
						}
					],
				},
			]
		}
	]);
});
client.once('reconnecting', () => { console.log('Reconnecting!'); });
client.once('disconnect',   () => { console.log('Disconnect!'); });
client.login();
