import produce from 'immer';
import TrackPlayer, {
    Event,
    RepeatMode,
    State,
    Track,
    usePlaybackState,
    useProgress,
} from 'react-native-track-player';
import shuffle from 'lodash.shuffle';
import musicIsPaused from '@/utils/musicIsPaused';
import Config from './config';
import {
    internalFakeSoundKey,
    internalSymbolKey,
    Quality,
    QualityList,
} from '@/constants/commonConst';
import StateMapper from '@/utils/stateMapper';
import delay from '@/utils/delay';
import {errorLog, trace} from '../utils/log';
import {isSameMediaItem, mergeProps} from '@/utils/mediaItem';
import PluginManager from './pluginManager';
import Network from './network';
import Toast from '@/utils/toast';
import LocalMusicSheet from './localMusicSheet';
import {SoundAsset} from '@/constants/assetsConst';

enum MusicRepeatMode {
    /** 随机播放 */
    SHUFFLE = 'SHUFFLE',
    /** 列表循环 */
    QUEUE = 'QUEUE',
    /** 单曲循环 */
    SINGLE = 'SINGLE',
}

/** 核心的状态 */
let currentIndex: number = -1;
let musicQueue: Array<IMusic.IMusicItem> = [];
let repeatMode: MusicRepeatMode = MusicRepeatMode.QUEUE;

const getRepeatMode = () => repeatMode;
const getCurrentMusicItem = () => musicQueue[currentIndex];
const getMusicQueue = () => musicQueue;

const currentMusicStateMapper = new StateMapper(getCurrentMusicItem);
const musicQueueStateMapper = new StateMapper(getMusicQueue);
const repeatModeStateMapper = new StateMapper(getRepeatMode);

/** 内部使用的排序id */
let globalId: number = 0; // 记录加入队列的次序

const maxMusicQueueLength = 1500; // 当前播放最大限制
const halfMaxMusicQueueLength = Math.floor(maxMusicQueueLength / 2);

/** 初始化 */
const setup = async () => {
    // 需要hook一下播放，所以采用这种方式
    await TrackPlayer.reset();
    await TrackPlayer.setRepeatMode(RepeatMode.Off);

    musicQueue.length = 0;
    /** 状态恢复 */
    try {
        const config = Config.get('status.music');
        if (config?.repeatMode) {
            repeatMode = config.repeatMode as MusicRepeatMode;
        }
        if (config?.musicQueue && Array.isArray(config?.musicQueue)) {
            addAll(
                config.musicQueue,
                undefined,
                true,
                repeatMode === MusicRepeatMode.SHUFFLE,
            );
        }
        if (config?.track) {
            currentIndex = findMusicIndex(config.track);
            // todo： 想想是在这里还是加在下边的play
            if (currentIndex !== -1) {
                musicQueue = produce(musicQueue, draft => {
                    draft[currentIndex] = config.track as IMusic.IMusicItem;
                });
            }
            // todo： 判空，理论上不会发生
            await TrackPlayer.add([config.track as Track, getFakeNextTrack()]);
        }

        if (config?.progress) {
            await TrackPlayer.seekTo(config.progress);
        }
        trace('状态恢复', config);
    } catch (e) {
        errorLog('状态恢复失败', e);
    }
    // 不要依赖playbackchanged，不稳定,
    // 一首歌结束了
    TrackPlayer.addEventListener(Event.PlaybackQueueEnded, async () => {
        if (repeatMode === MusicRepeatMode.SINGLE) {
            await play(undefined, true);
        } else {
            await skipToNext();
        }
    });

    /** 播放下一个 */
    TrackPlayer.addEventListener(Event.PlaybackTrackChanged, async evt => {
        // 是track里的，不是playlist里的
        trace('PlaybackTrackChanged', {
            evt,
        });

        if (
            evt.nextTrack === 1 &&
            (await TrackPlayer.getTrack(evt.nextTrack))?.$ ===
                internalFakeSoundKey
        ) {
            if (MusicQueue.getRepeatMode() === 'SINGLE') {
                await MusicQueue.play(undefined, true);
            } else {
                const queue = await TrackPlayer.getQueue();
                // 要跳到的下一个就是当前的，并且队列里面有多首歌  因为有重复事件
                if (
                    isSameMediaItem(
                        queue[1] as unknown as ICommon.IMediaBase,
                        MusicQueue.getCurrentMusicItem(),
                    ) &&
                    MusicQueue.getMusicQueue().length > 1
                ) {
                    return;
                }
                trace('PlaybackTrackChanged-shouldskip', {
                    evt,
                    queue,
                });

                await MusicQueue.skipToNext();
            }
        }
    });

    TrackPlayer.addEventListener(Event.PlaybackError, async e => {
        errorLog('Player播放失败', e);
        await _playFail();
    });

    currentMusicStateMapper.notify();
    repeatModeStateMapper.notify();
};

/** 播放模式相关 */
const _toggleRepeatMapping = {
    [MusicRepeatMode.SHUFFLE]: MusicRepeatMode.SINGLE,
    [MusicRepeatMode.SINGLE]: MusicRepeatMode.QUEUE,
    [MusicRepeatMode.QUEUE]: MusicRepeatMode.SHUFFLE,
};
const toggleRepeatMode = () => {
    setRepeatMode(_toggleRepeatMapping[repeatMode]);
};

const setRepeatMode = (mode: MusicRepeatMode) => {
    const currentMusicItem = musicQueue[currentIndex];
    if (mode === MusicRepeatMode.SHUFFLE) {
        musicQueue = shuffle(musicQueue);
    } else {
        musicQueue = produce(musicQueue, draft => {
            return draft.sort(
                (a, b) =>
                    a?.[internalSymbolKey]?.globalId -
                        b?.[internalSymbolKey]?.globalId ?? 0,
            );
        });
    }
    currentIndex = findMusicIndex(currentMusicItem);
    repeatMode = mode;
    TrackPlayer.updateMetadataForTrack(1, getFakeNextTrack());
    // 记录
    Config.set('status.music.repeatMode', mode, false);
    repeatModeStateMapper.notify();
    currentMusicStateMapper.notify();
    musicQueueStateMapper.notify();
};

// 获取目标item下标
const findMusicIndex = (musicItem?: IMusic.IMusicItem) =>
    musicItem
        ? musicQueue.findIndex(
              queueMusicItem =>
                  queueMusicItem.id === musicItem.id &&
                  queueMusicItem.platform === musicItem.platform,
          )
        : currentIndex;

const shrinkMusicQueueToSize = (
    queue: IMusic.IMusicItem[],
    targetIndex = currentIndex,
) => {
    // 播放列表上限，太多无法缓存状态
    if (queue.length > maxMusicQueueLength) {
        if (targetIndex < halfMaxMusicQueueLength) {
            queue = queue.slice(0, maxMusicQueueLength);
        } else {
            const right = Math.min(
                queue.length,
                targetIndex + halfMaxMusicQueueLength,
            );
            const left = Math.max(0, right - maxMusicQueueLength);
            queue = queue.slice(left, right);
        }
    }
    return queue;
};

/** 添加到播放列表 */
const addAll = (
    musicItems: Array<IMusic.IMusicItem> = [],
    beforeIndex?: number,
    notCache?: boolean,
    shouldShuffle?: boolean,
) => {
    const _musicItems = musicItems
        .map(item =>
            produce(item, draft => {
                if (draft[internalSymbolKey]) {
                    draft[internalSymbolKey].globalId = ++globalId;
                } else {
                    draft[internalSymbolKey] = {
                        globalId: ++globalId,
                    };
                }
            }),
        )
        .filter(_ => findMusicIndex(_) === -1);
    if (beforeIndex === undefined) {
        musicQueue = musicQueue.concat(_musicItems);
    } else {
        musicQueue = produce(musicQueue, draft => {
            draft.splice(beforeIndex, 0, ..._musicItems);
        });
    }
    // 播放列表上限，太多无法缓存状态
    musicQueue = shrinkMusicQueueToSize(
        musicQueue,
        findMusicIndex(_musicItems[0]),
    );
    if (!notCache) {
        Config.set('status.music.musicQueue', musicQueue, false);
    }
    if (shouldShuffle) {
        musicQueue = shuffle(musicQueue);
    }
    musicQueueStateMapper.notify();
};

/** 追加到队尾 */
const add = (
    musicItem: IMusic.IMusicItem | IMusic.IMusicItem[],
    beforeIndex?: number,
) => {
    addAll(Array.isArray(musicItem) ? musicItem : [musicItem], beforeIndex);
};

const addNext = (musicItem: IMusic.IMusicItem | IMusic.IMusicItem[]) => {
    const shouldPlay = musicQueue.length === 0;
    add(musicItem, currentIndex + 1);
    if (shouldPlay) {
        play(Array.isArray(musicItem) ? musicItem[0] : musicItem);
    }
};

const remove = async (musicItem: IMusic.IMusicItem) => {
    const _ind = findMusicIndex(musicItem);
    // 移除的是当前项
    if (_ind === currentIndex) {
        // 停下
        await TrackPlayer.reset();
        musicQueue = produce(musicQueue, draft => {
            draft.splice(_ind, 1);
        });
        if (musicQueue.length === 0) {
            currentIndex = -1;
        } else {
            currentIndex = currentIndex % musicQueue.length;
            play();
        }
    } else if (_ind !== -1 && _ind < currentIndex) {
        musicQueue = produce(musicQueue, draft => {
            draft.splice(_ind, 1);
        });
        currentIndex -= 1;
    } else {
        musicQueue = produce(musicQueue, draft => {
            draft.splice(_ind, 1);
        });
    }
    Config.set('status.music.musicQueue', musicQueue, false);
    musicQueueStateMapper.notify();
    currentMusicStateMapper.notify();
};

/** 清空播放列表 */
const clear = async () => {
    musicQueue = [];
    currentIndex = -1;

    Config.set('status.music', {
        repeatMode,
    });
    await TrackPlayer.reset();
    musicQueueStateMapper.notify();
    currentMusicStateMapper.notify();
};

/**
 * 获取自动播放的下一个track
 */
const getFakeNextTrack = () => {
    let track: Track | undefined;
    if (repeatMode === MusicRepeatMode.SINGLE) {
        track = musicQueue[currentIndex] as Track;
    } else {
        track =
            musicQueue.length !== 0
                ? (musicQueue[(currentIndex + 1) % musicQueue.length] as Track)
                : undefined;
    }

    if (track) {
        return produce(track, _ => {
            _.url = SoundAsset.fakeAudio;
            _.$ = internalFakeSoundKey;
        });
    } else {
        return {url: SoundAsset.fakeAudio, $: internalFakeSoundKey} as Track;
    }
};

const qualityUrlMapper = {
    [Quality.Standard]: 'urlST',
    [Quality.HighQuality]: 'urlHQ',
    [Quality.SuperQuality]: 'urlSQ',
} as const;

/** 播放音乐 */
const play = async (musicItem?: IMusic.IMusicItem, forcePlay?: boolean) => {
    try {
        trace('播放', musicItem);
        if (
            Network.isCellular() &&
            !Config.get('setting.basic.useCelluarNetworkPlay') &&
            !LocalMusicSheet.isLocalMusic(musicItem ?? null)
        ) {
            Toast.warn('当前设置移动网络不可播放，可在侧边栏基本设置中打开');
            await TrackPlayer.reset();
            return;
        }
        const _currentIndex = findMusicIndex(musicItem);
        if (!musicItem && _currentIndex === currentIndex && !forcePlay) {
            // 如果暂停就继续播放，否则
            const currentTrack = await TrackPlayer.getTrack(0);
            if (currentTrack && currentTrack.url) {
                const state = await TrackPlayer.getState();
                if (musicIsPaused(state)) {
                    trace('PLAY-继续播放', currentTrack);
                    await TrackPlayer.play();
                    return;
                }
                return;
            }
        }
        currentIndex = _currentIndex;

        if (currentIndex === -1) {
            if (musicItem) {
                add(musicItem);
                currentIndex = musicQueue.length - 1;
            } else {
                return;
            }
        }
        const _musicItem = musicQueue[currentIndex];
        let track: IMusic.IMusicItem;
        try {
            // 通过插件获取音乐
            const plugin = PluginManager.getByName(_musicItem.platform);
            const source = await plugin?.methods?.getMediaSource(_musicItem);
            const quality =
                Config.get('setting.basic.defaultPlayQuality') ??
                Quality.Standard;
            let url = source?.url;
            if (source?.[qualityUrlMapper[quality]]) {
                url = source[qualityUrlMapper[quality]];
            } else {
                const qIdx = QualityList.indexOf(quality);
                // 2是音质种类
                let nUrl;
                if (Config.get('setting.basic.playQualityOrder') === 'desc') {
                    // 优先高音质
                    for (let i = qIdx + 1; i < 3; ++i) {
                        nUrl = source?.[qualityUrlMapper[QualityList[i]]];
                        if (nUrl) {
                            url = nUrl;
                            break;
                        }
                    }
                    if (!nUrl) {
                        for (let i = qIdx - 1; i >= 0; --i) {
                            nUrl = source?.[qualityUrlMapper[QualityList[i]]];
                            if (nUrl) {
                                url = nUrl;
                                break;
                            }
                        }
                    }
                } else {
                    // 优先低音质
                    for (let i = qIdx - 1; i >= 0; --i) {
                        nUrl = source?.[qualityUrlMapper[QualityList[i]]];
                        if (nUrl) {
                            url = nUrl;
                            break;
                        }
                    }
                    if (!nUrl) {
                        for (let i = qIdx + 1; i < 3; ++i) {
                            nUrl = source?.[qualityUrlMapper[QualityList[i]]];
                            if (nUrl) {
                                url = nUrl;
                                break;
                            }
                        }
                    }
                }
            }
            const _source = {...(source ?? {}), url};
            // 获取音乐信息
            track = mergeProps(_musicItem, _source) as IMusic.IMusicItem;
            /** 可能点了很多次。。。 */
            if (!isSameMediaItem(_musicItem, musicQueue[currentIndex])) {
                return;
            }
            musicQueue = produce(musicQueue, draft => {
                draft[currentIndex] = track;
            });
            await replaceTrack(track as Track);
            currentMusicStateMapper.notify();

            const info = await plugin?.methods?.getMusicInfo?.(_musicItem);
            if (info && isSameMediaItem(_musicItem, musicQueue[currentIndex])) {
                await TrackPlayer.updateMetadataForTrack(0, info);
                musicQueue = produce(musicQueue, draft => {
                    draft[currentIndex] = mergeProps(
                        track as IMusic.IMusicItem,
                        info,
                    ) as IMusic.IMusicItem;
                });
                currentMusicStateMapper.notify();
            }
        } catch (e) {
            // 播放失败
            if (isSameMediaItem(_musicItem, musicQueue[currentIndex])) {
                await _playFail();
            }
            return;
        }
    } catch (e: any) {
        if (
            e?.message ===
            'The player is not initialized. Call setupPlayer first.'
        ) {
            trace('重新初始化player', '');
            await TrackPlayer.setupPlayer();
            play(musicItem, forcePlay);
        }
        errorLog('播放失败!!!', e?.message ?? '');
    }
};

const replaceTrack = async (track: Track, autoPlay = true) => {
    await TrackPlayer.reset();
    await TrackPlayer.remove([0, 1]);
    // console.log(await TrackPlayer.getQueue(), 'REPLACE-TRACK');
    await TrackPlayer.add([track, getFakeNextTrack()]);
    // console.log(await TrackPlayer.getQueue(), 'REPLACE-TRACK-AFTER-ADD');
    if (autoPlay) {
        await TrackPlayer.play();
    }
    Config.set('status.music.track', track as IMusic.IMusicItem, false);
    Config.set('status.music.progress', 0, false);
};

const _playFail = async () => {
    errorLog('播放失败，自动跳过', {
        currentIndex,
    });
    await TrackPlayer.reset();
    await TrackPlayer.add([
        (musicQueue[currentIndex] ?? {
            url: SoundAsset.fakeAudio,
            $: internalFakeSoundKey,
        }) as Track,
        getFakeNextTrack(),
    ]);
    if (!Config.get('setting.basic.autoStopWhenError')) {
        await delay(300);
        await skipToNext();
    }
};

const playWithReplaceQueue = async (
    musicItem: IMusic.IMusicItem,
    newQueue: IMusic.IMusicItem[],
) => {
    if (newQueue.length !== 0) {
        newQueue = shrinkMusicQueueToSize(
            newQueue,
            newQueue.findIndex(_ => isSameMediaItem(_, musicItem)),
        );
        musicQueue = [];
        addAll(
            newQueue,
            undefined,
            undefined,
            repeatMode === MusicRepeatMode.SHUFFLE,
        );
        await play(musicItem, true);
    }
};

const pause = async () => {
    await TrackPlayer.pause();
};

const skipToNext = async () => {
    console.log('SKIP');
    if (musicQueue.length === 0) {
        currentIndex = -1;
        return;
    }

    await play(musicQueue[(currentIndex + 1) % musicQueue.length], true);
};

const skipToPrevious = async () => {
    if (musicQueue.length === 0) {
        currentIndex = -1;
        return;
    }
    if (currentIndex === -1) {
        currentIndex = 0;
    }
    await play(
        musicQueue[(currentIndex - 1 + musicQueue.length) % musicQueue.length],
        true,
    );
};

const MusicQueue = {
    setup,
    useMusicQueue: musicQueueStateMapper.useMappedState,
    getMusicQueue: getMusicQueue,
    addAll,
    add,
    addNext,
    skipToNext,
    skipToPrevious,
    play,
    playWithReplaceQueue,
    pause,
    remove,
    clear,
    useCurrentMusicItem: currentMusicStateMapper.useMappedState,
    getCurrentMusicItem: getCurrentMusicItem,
    useRepeatMode: repeatModeStateMapper.useMappedState,
    getRepeatMode,
    toggleRepeatMode,
    MusicRepeatMode,
    usePlaybackState,
    MusicState: State,
    useProgress,
    reset: TrackPlayer.reset,
    seekTo: TrackPlayer.seekTo,
    currentIndex,
};

export default MusicQueue;
