
import NsfPlayer           from './nsf-player';
import LoopPlayer          from './loop-player';
import { sendLoopRequest } from './loop-player';
import ytpl         from 'ytpl';
import ytdl         from 'ytdl-core';
import YouTube      from 'youtube-sr';
import Discord      from 'discord.js';
import path         from 'path';
import { URL }      from "url";
import { Readable } from 'stream';
import {
    AudioPlayerState,
    AudioPlayerStatus,
    AudioResource,
    PlayerSubscription,
    StreamType,
    createAudioPlayer,
    createAudioResource,
    entersState,
    getVoiceConnection,
    joinVoiceChannel,
} from '@discordjs/voice';
import {
    ApplicationCommandType,
    ApplicationCommandOptionType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    ModalActionRowComponentBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle,
} from "discord.js";

const MaxSongsToShow = 15;
const ONE_HOUR_MS: number = 3600_000;
type SongType = "YouTube" | "Dropbox" | "Chiptune";
interface SongQueue { songs: SongItem[] };
interface SongItem {
    type:         SongType,
    interaction:  Discord.Interaction,
    title:        string,
    url?:         string,
    chiptune?:    ArrayBuffer,
    trackNumber?: number,
    loop?:        boolean,
};

// Song queue[Guild ID -> Actual queue]
const queue: Map<string, SongQueue> = new Map();
const subscriptions: Map<string, PlayerSubscription|undefined> = new Map(); // Audio subscriptions
const functionTable: Map<string, (interaction: Discord.Interaction) => void> = new Map();
const client = new Discord.Client({
    intents: [
        Discord.IntentsBitField.Flags.Guilds,
        Discord.IntentsBitField.Flags.GuildMessages,
        Discord.IntentsBitField.Flags.GuildMessageTyping,
        Discord.IntentsBitField.Flags.GuildVoiceStates,
        Discord.GatewayIntentBits.MessageContent
    ]
});

// ytdlでフォーマットを気にしつつReadableを持ってくる
export async function getYtdlStream(url: string): Promise<[Readable, ytdl.videoInfo, StreamType]> {
    const id = ytdl.getURLVideoID(url);
    const info = await ytdl.getInfo(url);
    let inputType = StreamType.WebmOpus;
    let filter: ytdl.Filter = (filter: ytdl.videoFormat) =>
        filter.audioCodec === "opus" && filter.container === "webm";
    const formats = ytdl.filterFormats(info.formats, filter);
    if (formats.length === 0) {
        inputType = StreamType.Arbitrary;
        filter = "audio";
    }
    const stream = ytdl(id, {
        highWaterMark: 32 * 1024 * 1024,
        quality: "lowestaudio",
        filter: filter
    });
    return [stream, info, inputType];
}

// URLにパラメータfieldがあるかどうかを返す
function parameterExists(url: string, field: string): boolean {
    return url.indexOf(`?${field}=`) != -1 || url.indexOf(`&${field}=`) != -1;
}

// Milliseconds → "HH:MM:SS"
function formatTime(ms: number): string {
    const str = new Date(ms).toISOString();
    if (ms < ONE_HOUR_MS) return str.substring(14, 19);
    return str.substring(11, 19);
}

// 再生キューをシャッフルする
function shuffle(interaction: Discord.Interaction, gag?: boolean) {
    if (!interaction.inCachedGuild()) return;
    if (!interaction.isRepliable()) return;
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
        console.log(ss.player.state);
        const currentPlaying = songs.indexOf(firstSong);
        [songs[0], songs[currentPlaying]] = [songs[currentPlaying], songs[0]];
    }

    if (gag) return;
    interaction.editReply("Shuffled the queue!").catch(console.error);
    setTimeout(() => { interaction.deleteReply().catch(console.error); }, 1000 * 5);
}

// 再生キューから曲を取り出し再生する。再生が終わるとキューから消去される。
async function play(guild: Discord.Guild, song: SongItem) {
    const interaction = song.interaction;
    const serverQueue = queue.get(guild.id);
    const connection = getVoiceConnection(guild.id);
    if (!interaction.channel) return;
    if (!serverQueue) return;
    if (!connection) return;
    try {
        // https://scrapbox.io/discordjs-japan/ytdl-core_を使用して_YouTube_の音源を配信するサンプル
        let resource: AudioResource, durationMs: number;
        const audioPlayer = createAudioPlayer();
        subscriptions.set(guild.id, connection.subscribe(audioPlayer));
        audioPlayer.removeAllListeners("stateChange");
        
        if (song.loop && song.url) {
            const player = new LoopPlayer(song.url);
            resource = createAudioResource(player, { inputType: StreamType.Raw });
            durationMs = -1;
        }
        else {
            switch (song.type) {
                case "YouTube": {
                    if (!song.url) return;
                    const [stream, info, inputType] = await getYtdlStream(song.url);
                    durationMs = Number(info.videoDetails.lengthSeconds) * 1000;
                    resource = createAudioResource(stream, { inputType });
                    break;
                }
                case "Dropbox": {
                    if (!song.url) return;
                    const res = await fetch(song.url);
                    if (!res.body) return;
                    const reader = res.body?.getReader();
                    const stream = new Readable({
                        read() {
                            reader?.read().then(({ done, value }) => this.push(done ? null : value))
                            .catch(err => this.destroy(err));
                        }
                    });
                    resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
                    durationMs = resource.playbackDuration;
                    break;
                }
                case "Chiptune": {
                    if (!song.chiptune) return;
                    const player = new NsfPlayer(song.chiptune, song.trackNumber ?? 0);
                    resource = createAudioResource(player, { inputType: StreamType.Raw });
                    durationMs = -1;
                    break;
                }
            }
        }
        const initTime = durationMs < 0 ? '-' : (durationMs < ONE_HOUR_MS ? '00:00' : '00:00:00');
        const duration = durationMs < 0 ? '-' : formatTime(durationMs);
        const title = song.title;
        const url = song.url ? `${song.url}\n` : '';
        const prefix = `**${title}** \n${url}`;
        const btn_shuffle = new ButtonBuilder()
            .setCustomId('shuffle')
            .setLabel('シャッフル')
            .setStyle(ButtonStyle.Primary);
        const btn_stop = new ButtonBuilder()
            .setCustomId('stop')
            .setLabel('■')
            .setStyle(ButtonStyle.Danger);
        const btn_skip = new ButtonBuilder()
            .setCustomId('skip')
            .setLabel('▶▶|')
            .setStyle(ButtonStyle.Primary);
        const btn_search = new ButtonBuilder()
            .setCustomId('btn_search')
            .setLabel('検索')
            .setStyle(ButtonStyle.Secondary);
        const menu_queue = new StringSelectMenuBuilder()
            .setCustomId('menu_queue');
        function refreshControls() {
            const songs = serverQueue?.songs;
            if (!songs) return;
            const list = []
            if (songs.length > 1) {
                let text = `𝗨𝗣 𝗡𝗘𝗫𝗧: ${songs[1].title}`;
                if (text.length > 150) text = text.substring(0, 150 - 3) + '...';
                menu_queue.setPlaceholder(text);
            }
            else {
                menu_queue.setPlaceholder('再生キュー');
            }
            for (let i = 2; i < songs.length; ++i) {
                let text = `${i - 1}. ${songs[i].title}`;
                if (text.length > 100) text = text.substring(0, 100 - 3) + '...';
                list.push(new StringSelectMenuOptionBuilder()
                    .setValue(`${i - 1}`).setLabel(text));
                if (i > MaxSongsToShow) {
                    list.push(new StringSelectMenuOptionBuilder()
                        .setValue(`${i}`).setLabel('...'));
                    break;
                }
            }
            if (list.length > 0) {
                menu_queue.setOptions(...list);
            }
            else {
                menu_queue.setOptions(new StringSelectMenuOptionBuilder()
                    .setValue('0').setLabel('（曲がありません）'));
            }
            btn_shuffle.setDisabled(songs.length < 3);
        }

        refreshControls();
        const buttons = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(btn_shuffle)
            .addComponents(btn_stop)
            .addComponents(btn_skip)
            .addComponents(btn_search);
        const row_queue = new ActionRowBuilder<StringSelectMenuBuilder>()
            .addComponents(menu_queue);
        const messageObject = {
            content: `${prefix}> \`${initTime} / ${duration}\` `,
            components: [ buttons, row_queue ]
        };
        const message = await interaction.channel.send(messageObject);
        
        let removed = false;
        const id = setInterval(() => {
            if (durationMs < 0) return;
            const current = resource.playbackDuration;
            if (removed) return;
            refreshControls();
            messageObject.content = `${prefix}> \`${formatTime(current)} / ${duration}\` `;
            message.edit(messageObject).catch(console.error);
        }, 1000);
        audioPlayer.addListener("stateChange", (_, after: AudioPlayerState) => {
            console.log(`[Player status] ${_.status} -> ${after.status}`);
            if (after.status !== "idle") return;
            removed = true;
            clearInterval(id);
            if (message.deletable) message.delete().catch(console.error);
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
function pushQueue(interaction: Discord.Interaction, song: SongItem, gag?: boolean, insertNext?: boolean) {
    if (!interaction.inCachedGuild()) return;
    if (!interaction.isRepliable()) return;
    const serverQueue = queue.get(interaction.guild.id);
    const connection = getVoiceConnection(interaction.guild.id);
    if (!connection && interaction.member.voice.channel?.id) {
        try {
            // Here we try to join the voicechat and save our connection into our object.
            joinVoiceChannel({
                channelId: interaction.member.voice.channel?.id,
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
        // Setting the queue using our contract
        // Pushing the song to our songs array
        queue.set(interaction.guild.id, {
            songs: [ song ],
        });
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
    return interaction.editReply(`**${song.title}** has been added to the queue!`).catch(console.error);
}
async function startPlaying(interaction: Discord.Interaction, playLater?: boolean) {
    if (!interaction.inCachedGuild()) return;
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
        if (!interaction.isRepliable()) return;
        return await interaction.editReply("Failed to play a song!").catch(console.error);
    }
}
async function play_impl(interaction: Discord.Interaction, url: string, aux: string) {
    if (!interaction.isRepliable()) return;
    if (!interaction.inCachedGuild()) return;
    const isdropbox = url.includes("dropbox.com");
    const shortened = url.includes("youtu.be");
    const keywords = ["shuffle", "next", "now", "loop"];
    
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
            type:        "Dropbox",
            interaction: interaction,
            title:       path.basename(parsed.pathname),
            url:         parsed.toString(),
            // loop:        aux === keywords[3],
        }, false, aux === keywords[1] || aux === keywords[2]);
    }
    const validVideo = parameterExists(url, "v")     || ytdl.validateID(url);
    const validList = !parameterExists(url, "index") && ytpl.validateID(url);
    if (validList) { // プレイリストの追加
        try {
            const pl = await ytpl(url, { limit: Infinity });
            pl.items.forEach(i => {
                pushQueue(interaction, {
                    type:        "YouTube",
                    interaction: interaction,
                    title:       i.title,
                    url:         i.shortUrl,
                    // loop: aux === keywords[3],
                }, true, aux === keywords[1] || aux == keywords[2]);
            });

            await interaction.editReply("Added a playlist to the queue!").catch(console.error);
            if (aux == keywords[0]) shuffle(interaction, true);
        }
        catch (error) {
            console.error(error);
            return await interaction.editReply("I can't fetch playlist info!").catch(console.error);
        }
    }
    else if (validVideo) { // 曲の追加
        try {
            const songInfo = await ytdl.getInfo(url);
            await pushQueue(interaction, {
                type:        "YouTube",
                interaction: interaction,
                title:       songInfo.videoDetails.title,
                url:         songInfo.videoDetails.video_url,
                loop:        aux === keywords[3],
            }, false, aux === keywords[1] || aux === keywords[2]);
            if (aux === keywords[3]) {
                await sendLoopRequest(songInfo.videoDetails.video_url);
            }
        }
        catch (error) {
            console.error(error);
            return await interaction.editReply("I can't fetch video info!").catch(console.error);
        }
    }
    else { // 曲の検索
        const video = await YouTube.searchOne(url).catch(console.error);
        if (video) {
            return await play_impl(interaction, video.url, aux);
        }
    }
    startPlaying(interaction, aux !== keywords[2]);
}

functionTable.set("shuffle", shuffle);
// !playのパラメータ解析と曲の追加 → 再生
functionTable.set("play", async function(interaction: Discord.Interaction) {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.isRepliable()) return;
    if (!interaction.inCachedGuild()) return;
    setTimeout(() => { interaction.deleteReply().catch(console.error); }, 1000 * 5);
    const voiceChannel = interaction.member?.voice.channel;
    const permissions = voiceChannel?.permissionsFor(interaction.client.user);
    if (!voiceChannel) {
        return await interaction.editReply("You need to be in a voice channel to play music!").catch(console.error);
    }
    if (!permissions?.has(Discord.PermissionsBitField.Flags.Connect)
    ||  !permissions?.has(Discord.PermissionsBitField.Flags.Speak)) {
        return await interaction.editReply("I need the permissions to join and speak in your voice channel!").catch(console.error);
    }

    // optionの解析
    const url = interaction.options.getString('url') ?? '';
    const aux = interaction.options.getString('option') ?? '';
    await play_impl(interaction, url, aux);
});
// 現在再生中の曲をスキップして次の曲を流す
functionTable.set("skip", function(interaction: Discord.Interaction) {
    if (!interaction.isRepliable()) return;
    if (!interaction.inCachedGuild()) return;
    const ss = subscriptions.get(interaction.guild.id);
    if (!ss?.player) return;
    ss.player.stop();
    interaction.deleteReply().catch(console.error);
});
// 曲の再生を止め、再生キューを消去し、VCから抜ける
functionTable.set("stop", function(interaction: Discord.Interaction) {
    if (!interaction.isRepliable()) return;
    if (!interaction.inCachedGuild()) return;
    const id = interaction.guild.id;
    const connection = getVoiceConnection(id);
    const serverQueue = queue.get(id);
    const ss = subscriptions.get(id);
    if (ss?.player) ss.player.stop(true);
    if (connection) connection.destroy();
    if (serverQueue) queue.delete(id);
    if (ss) subscriptions.delete(id);
    interaction.deleteReply().catch(console.error);
});
// 再生キューを全消去する
functionTable.set("clear", function(interaction: Discord.Interaction) {
    if (!interaction.isRepliable()) return;
    if (!interaction.inCachedGuild()) return;
    const serverQueue = queue.get(interaction.guild.id);
    if (!serverQueue) return;
    serverQueue.songs = [];
    interaction.deleteReply().catch(console.error);
});
// 再生キューをチャットに表示する 多すぎると送れないので15件まで出す
functionTable.set("queue", function(interaction: Discord.Interaction) { 
    if (!interaction.isRepliable()) return;
    if (!interaction.inCachedGuild()) return;
    const serverQueue = queue.get(interaction.guild.id);
    const songs = serverQueue?.songs;
    if (!songs || songs.length == 0) {
        interaction.editReply("No queue here!").catch(console.error);
        setTimeout(() => { interaction.deleteReply().catch(console.error); }, 1000 * 5);
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
    interaction.editReply(msg).catch(console.error);
    setTimeout(() => { interaction.deleteReply().catch(console.error); }, 1000 * 30);
});
// 次の曲を表示する
functionTable.set("upnext", function(interaction: Discord.Interaction) {
    if (!interaction.isRepliable()) return;
    if (!interaction.inCachedGuild()) return;
    const serverQueue = queue.get(interaction.guild.id);
    const songs = serverQueue?.songs;
    if (!songs || songs.length < 2) {
        interaction.editReply("No song to play next!").catch(console.error);
    }
    else {
        interaction.editReply(`Up next ~ **${songs[1].title}**\n${songs[1].url}`).catch(console.error);
    }
    setTimeout(() => { interaction.deleteReply().catch(console.error); }, 1000 * 5);
});
// NSFを再生する
functionTable.set("chiptune", async function(interaction: Discord.Interaction) {
    if (!interaction.isRepliable()) return;
    if (!interaction.isChatInputCommand()) return;
    setTimeout(() => { interaction.deleteReply().catch(console.error); }, 1000 * 5);
    const att = interaction.options.getAttachment('chiptune');
    const aux = interaction.options.getString('option');
    const track = interaction.options.getInteger('track') ?? undefined;
    const keywords = ["shuffle", "next", "now"];
    const response = await fetch(att?.url ?? "");
    if (response.status !== 200) {
        console.error("Failed to load NSF", response.status);
        return interaction.editReply("Failed to load NSF!").catch(console.error);
    }
    const buffer = await response.arrayBuffer();
    pushQueue(interaction, {
        type:        "Chiptune",
        interaction: interaction,
        chiptune:    buffer,
        trackNumber: track,
        title:       att?.name ?? "Chiptune music",
    }, false, aux === keywords[1] || aux === keywords[2]);
    startPlaying(interaction, aux !== keywords[2]);
});
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    if (!interaction.isRepliable()) return;
    await interaction.reply('｡ﾟ(ﾟ´ω`ﾟ)ﾟ｡');
    const cmd = interaction.commandName;
    const cmdMatch = [...functionTable.keys()].filter(c => c === cmd);
    if (cmdMatch.length > 0) return functionTable.get(cmdMatch[0])?.(interaction);
});
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    if (interaction.customId === 'btn_search') {
        const modal = new ModalBuilder().setCustomId('modal_search').setTitle('動画を検索して再生');
        const txt_search = new TextInputBuilder().setCustomId('txt_search').setLabel('検索キーワード').setStyle(TextInputStyle.Short);
        const row = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(txt_search);
        modal.addComponents(row);
        await interaction.showModal(modal);
    }
    else {
        await interaction.reply('｡ﾟ(ﾟ´ω`ﾟ)ﾟ｡');
        functionTable.get(interaction.customId)?.(interaction);
    }
});
client.on('interactionCreate', async interaction => {
    if (interaction.isStringSelectMenu()) {
        await interaction.reply('｡ﾟ(ﾟ´ω`ﾟ)ﾟ｡');
        setTimeout(() => { interaction.deleteReply().catch(console.error); }, 1);
        return;
    }

    if (!interaction.isModalSubmit()) return;
    await interaction.reply('｡ﾟ(ﾟ´ω`ﾟ)ﾟ｡');
    setTimeout(() => { interaction.deleteReply().catch(console.error); }, 1000 * 5);
    const url = interaction.fields.getTextInputValue('txt_search');
    await play_impl(interaction, url, '');
});
client.on("ready", async () => {
    console.log(`${client.user?.tag} has logged in.`);
    client.user?.setActivity("作業用BGM", { type: Discord.ActivityType.Playing });
    await client.application?.commands.set([
        {
            'name': 'play',
            'type': ApplicationCommandType.ChatInput,
            'description': 'YouTubeのURLを指定してプレイリストに追加します。',
            'options': [
                {
                    'name': 'url',
                    'description': 'YouTubeのURL。プレイリストのURLを指定することも可能。',
                    'type': ApplicationCommandOptionType.String,
                    'required': true,
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
                        },
                        {
                            'name': 'ループ再生',
                            'value': 'loop',
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
