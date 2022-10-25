
// Required modules:
//   @discordjs/opus@0.5.3
//   @discordjs/voice@0.6.0
//   discord.js@13.2.0
//   ffmpeg@0.0.4
//   tweetnacl@1.0.3
//   ytdl-core@4.9.1
//   ytpl@2.2.3
// Install them by:
// $ npm install @discordjs/opus @discordjs/voice discord.js ffmpeg tweetnacl ytdl-core ytpl
// Base example taken from https://gabrieltanner.org/blog/dicord-music-bot
// デプロイ参考: https://qiita.com/InkoHX/items/590b5f15426a6e813e92

const ytpl = require('ytpl')
const Discord = require('discord.js');
const { joinVoiceChannel, StreamType } = require('@discordjs/voice');
const { getVoiceConnection } = require('@discordjs/voice');
const { createAudioPlayer } = require('@discordjs/voice');
const { createAudioResource } = require('@discordjs/voice');
const { entersState } = require('@discordjs/voice');
const { AudioPlayerStatus } = require('@discordjs/voice');
const { prefix, channel, useChannelFilter } = require('./config.json');
const ytdl = require('ytdl-core');
const queue = new Map(); // Song queue
const subscriptions = new Map(); // Audio subscriptions

const client = new Discord.Client({
	intents: [
		Discord.Intents.FLAGS.GUILDS,
		Discord.Intents.FLAGS.GUILD_MESSAGES,
		Discord.Intents.FLAGS.GUILD_MESSAGE_TYPING,
		Discord.Intents.FLAGS.GUILD_VOICE_STATES
	]
});

client.once('ready', () => { console.log('Ready!'); });
client.once('reconnecting', () => { console.log('Reconnecting!'); });
client.once('disconnect', () => { console.log('Disconnect!'); });

// URLにパラメータfieldがあるかどうかを返す
// https://stackoverflow.com/questions/1314383/how-to-check-if-a-query-string-value-is-present-via-javascript/24179815
function parameterExists(url, field) {
	return url.indexOf(`?${field}=`) != -1 || url.indexOf(`&${field}=`) != -1;
}

// 再生キューをシャッフルする
function shuffle(message, gag) {
	const serverQueue = queue.get(message.guild.id);
	if (!serverQueue) return;
	const songs = serverQueue.songs;
	if (!songs) return;
	const firstSong = songs[0];
	for (let i = songs.length - 1; i >= 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[songs[i], songs[j]] = [songs[j], songs[i]];
	}

	// 現在再生中の場合、先頭の曲は再生が終わると消されるので元と同じにする
	const ss = subscriptions.get(message.guild.id);
	if (ss?.player) {
		console.log(ss.player.status);
		const currentPlaying = songs.indexOf(firstSong);
		[songs[0], songs[currentPlaying]] = [songs[currentPlaying], songs[0]];
	}

	if (gag) return;
	return message.channel.send("Shuffled the queue!");
}

// 再生キューをチャットに表示する
// 多すぎると送れないので15件まで出る
const MaxSongsToShow = 15;
function showQueue(message) {
	const serverQueue = queue.get(message.guild.id);
	const songs = serverQueue?.songs;
	if (!songs || songs.length == 0) return message.channel.send("No queue here!");

	let msg = "Queue:\n";
	for (let i = 0; i < songs.length; ++i) {
		msg = msg + `  ${songs[i].title}\n`
		if (i > MaxSongsToShow) {
			msg = msg + "  ...";
			break;
		}
	}
	return message.channel.send(msg);
}

// 次の曲を表示する
function showUpnext(message) {
	const serverQueue = queue.get(message.guild.id);
	const songs = serverQueue?.songs;
	if (!songs || songs.length < 2) return message.channel.send("No song to play next!");
	return message.channel.send(`Up next ~ **${songs[1].title}**\n${songs[1].url}`);
}

// 今の曲を表示する
function showNowPlaying(message) {
	const serverQueue = queue.get(message.guild.id);
	const songs = serverQueue?.songs;
	if (!songs || songs.length == 0) return message.channel.send("No song there!");
	return message.channel.send(`Now playing ~ **${songs[0].title}**\n${songs[0].url}`);
}

// 再生キューを全消去する
function clearQueue(message) {
	const serverQueue = queue.get(message.guild.id);
	if (!serverQueue) return;
	serverQueue.songs = undefined;
	return message.channel.send("Cleared the queue!");
}

// 再生キューから曲を取り出し再生する。再生が終わるとキューから消去される。
async function play(message, song) {
	const guild = message.guild;
	const serverQueue = queue.get(guild.id);
	const connection = getVoiceConnection(guild.id);
	if (!song) return;

	try {
		// https://scrapbox.io/discordjs-japan/ytdl-core_を使用して_YouTube_の音源を配信するサンプル
		const audioPlayer = createAudioPlayer();
		subscriptions.set(guild.id, connection.subscribe(audioPlayer));
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
		const resource = createAudioResource(stream, { inputType: type });
		
		audioPlayer.play(resource); // 再生
		serverQueue.textChannel.send(`Start playing: **${song.title}**`);
		await entersState(audioPlayer, AudioPlayerStatus.Playing, 10 * 1000);
		await entersState(audioPlayer, AudioPlayerStatus.Idle, 24 * 60 * 60 * 1000);
	}
	catch (error) {
		console.error(error);
		message.channel.send("Failed to play a song!");
	}

	serverQueue.songs.shift();
	if (serverQueue.songs.length > 0) {
		play(message, serverQueue.songs[0]);
	}
	else {
		queue.delete(guild.id);
		subscriptions.delete(guild.id);
	}
}

// 現在再生中の曲をスキップして次の曲を流す
function skip(message) {
	const ss = subscriptions.get(message.guild.id);
	if (!ss?.player) return;
	ss.player.stop();
}

// 曲の再生を止め、再生キューを消去し、VCから抜ける
function stop(message) {
	const connection = getVoiceConnection(message.guild.id);
	const serverQueue = queue.get(message.guild.id);
	const ss = subscriptions.get(message.guild.id);
	if (connection) connection.destroy();
	if (serverQueue) queue.delete(message.guild.id);
	if (ss) subscriptions.delete(message.guild.id);
	if (ss?.player) ss.player.stop();
}

// 曲を再生キューに追加する
// bool gag: チャットを送らない。プレイリスト内の曲を追加する時にうるさいので使う
// bool insertNext: キューの2番めに追加して、次に再生する曲とする
function pushQueue(message, song, gag, insertNext) {
	const serverQueue = queue.get(message.guild.id);
	const connection = getVoiceConnection(message.guild.id);
	if (!connection) {
		try {
			// Here we try to join the voicechat and save our connection into our object.
			joinVoiceChannel({
				channelId: message.member.voice.channel.id,
				guildId: message.guild.id,
				adapterCreator: message.guild.voiceAdapterCreator
			})
		} catch (err) {
			// Printing the error message if the bot fails to join the voicechat
			console.log(err);
			console.log("error at joinning VC");
			queue.delete(message.guild.id);
			return;
		}
	}

	if (!serverQueue) {
		// Creating the contract for our queue
		const queueContruct = {
			textChannel: message.channel,
			songs: [],
			volume: 5,
			playing: true,
		};
	   
		queue.set(message.guild.id, queueContruct); // Setting the queue using our contract
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

		if (gag) return;
		return message.channel.send(`**${song.title}** has been added to the queue!`);
	}
}

// !DKplayのパラメータ解析と曲の追加 → 再生
async function execute(message) {
	const args = message.content.split(" ");
	const voiceChannel = message.member.voice.channel;
	const permissions = voiceChannel?.permissionsFor(message.client.user);
	if (!voiceChannel) return message.channel.send("You need to be in a voice channel to play music!");
	if (!permissions?.has("CONNECT") || !permissions?.has("SPEAK")) {
		return message.channel.send("I need the permissions to join and speak in your voice channel!");
	}

	// optionの解析
	const shuffleBeforePlaying = args[1] && args[1].toLowerCase() === "shuffle";
	const playNext = args[1] && args[1].toLowerCase() === "next";
	const playNow = args[1] && args[1].toLowerCase() === "now";
	if (shuffleBeforePlaying || playNext || playNow) {
		args[1] = args[2];
		args.length--;
	}
	
	// URLが与えられている時
	if (args.length > 1) {
		const validVideo = parameterExists(args[1], "v")     || ytdl.validateID(args[1]);
		const validList = !parameterExists(args[1], "index") && ytpl.validateID(args[1]);
		if (validList) { // プレイリストの追加
			try {
				const pl = await ytpl(args[1], { limit: Infinity });
				pl.items.forEach(i => {
					pushQueue(message, {
						title: i.title,
						url: i.shortUrl,
					}, true, playNext || playNow);
				});

				message.channel.send("Added a playlist to the queue!");
				if (shuffleBeforePlaying) shuffle(message, true);
			}
			catch (error) {
				console.error(error);
				return message.channel.send("I can't fetch playlist info!");
			}
		}
		else if (validVideo) { // 曲の追加
			try {
				const songInfo = await ytdl.getInfo(args[1]);
				await pushQueue(message, {
					title: songInfo.videoDetails.title,
					url: songInfo.videoDetails.video_url,
				}, false, playNext || playNow);
			}
			catch (error) {
				console.error(error);
				return message.channel.send("I can't fetch video info!");
			}
		}
	}
	
	try {
		// Calling the play function to start a song
		const serverQueue = queue.get(message.guild.id);
		const ss = subscriptions.get(message.guild.id);
		if (!serverQueue) return;
		if (ss?.player) {
			if (!playNow) return;
			return ss.player.stop();
		}
		else {
			play(message, serverQueue.songs[0]);
		}
	}
	catch (error) {
		console.error("Error at playing a song");
		console.error(error);
		return message.channel.send("Failed to play a song!");
	}
}

const functionTable = new Map();
functionTable.set("play",       execute);
functionTable.set("skip",       skip);
functionTable.set("stop",       stop);
functionTable.set("clear",      clearQueue);
functionTable.set("shuffle",    shuffle);
functionTable.set("queue",      showQueue);
functionTable.set("upnext",     showUpnext);
functionTable.set("np",         showNowPlaying);
functionTable.set("nowplaying", showNowPlaying);
client.on('messageCreate', (message) => {
	if (useChannelFilter && message.channel.id !== channel) return;
	if (message.author.bot) return;

	const command = message.content.toLowerCase();
	if (!command.startsWith(prefix)) return;
	
	const cmdMatch = [...functionTable.keys()].filter(cmd => command.startsWith(prefix + cmd));
	if (cmdMatch.length > 0) return functionTable.get(cmdMatch[0])?.(message);
	
	return message.channel.send(
	  "**!DKplay [option] (URL)** 曲をキューに追加\n"
	+ "```\n"
	+ "何らかの理由で再生が止まった時に、\n"
	+ "キューの続きから再生する役目もある。\n"
	+ "[option]は以下のうちどれか1つ:\n"
	+ "shuffle プレイリストをシャッフルしてから追加する\n"
	+ "next    再生キューに割り込んで次に再生する\n"
	+ "now     再生中の曲を中断してすぐに再生する\n"
	+ "```\n"
	+ "**!DKskip** 現在再生中の曲をスキップ\n"
	+ "**!DKstop** 再生を停止してキューを消去する\n"
	+ "**!DKclear** 再生キューを全消去\n"
	+ "**!DKshuffle** 再生キューをシャッフル\n"
	+ "**!DKqueue** 再生キューを表示\n"
	+ "**!DKnp**, **!DKnowplaying** 現在再生中の曲を表示\n"
	+ "**!DKupnext** 次に再生する曲を表示");
});

client.login();
