declare namespace IPlugin {
    export interface IMediaSourceResult {
        headers?: Record<string, string>;
        /** 兜底播放 */
        url?: string;
        /** 标准音质 */
        urlST?: string;
        /** 高品质 */
        urlHQ?: string;
        /** 超高音质 */
        urlSQ?: string;
        userAgent?: string;
    }

    export interface ISearchResult<T extends ICommon.SupportMediaType> {
        isEnd?: boolean;
        data: ICommon.SupportMediaItemBase[T][];
    }

    export type ISearchResultType = ICommon.SupportMediaType;

    type ISearchFunc = <T extends ICommon.SupportMediaType>(
        query: string,
        page: number,
        type: T,
    ) => Promise<ISearchResult<T>>;

    type IGetArtistWorksFunc = <T extends IArtist.ArtistMediaType>(
        artistItem: IArtist.IArtistItem,
        page: number,
        type: T,
    ) => Promise<ISearchResult<T>>;

    interface IUserEnv {
        key: string;
        name: string;
    }

    interface IPluginDefine {
        /** 来源名 */
        platform: string;
        /** 匹配的版本号 */
        appVersion?: string;
        /** 插件版本 */
        version?: string;
        /** 远程更新的url */
        srcUrl?: string;
        /** 主键，会被存储到mediameta中 */
        primaryKey?: string[];
        /** 默认搜索类型 */
        defaultSearchType?: ICommon.SupportMediaType;
        /** 插件缓存控制 */
        cacheControl?: 'cache' | 'no-cache' | 'no-store';
        /** 用户自定义输入 */
        userEnv?: IUserEnv[];
        /** 搜索 */
        search?: ISearchFunc;
        /** 获取根据音乐信息获取url */
        getMediaSource?: (
            musicItem: IMusic.IMusicItemBase,
        ) => Promise<IMediaSourceResult | null>;
        /** 根据主键去查询歌曲信息 */
        getMusicInfo?: (
            musicBase: ICommon.IMediaBase,
        ) => Promise<Partial<IMusic.IMusicItem> | null>;
        /** 获取歌词 */
        getLyric?: (
            musicItem: IMusic.IMusicItemBase,
        ) => Promise<ILyric.ILyricSource | null>;
        /** 获取专辑信息，里面的歌曲不要分页 */
        getAlbumInfo?: (
            albumItem: IAlbum.IAlbumItemBase,
        ) => Promise<IAlbum.IAlbumItem | null>;
        /** 获取作品，有分页 */
        getArtistWorks?: IGetArtistWorksFunc;
        /** 导入歌单 */
        // todo: 数据结构应该是IMusicSheetItem
        importMusicSheet?: (
            urlLike: string,
        ) => Promise<IMusic.IMusicItem[] | null>;
        /** 导入单曲 */
        importMusicItem?: (
            urlLike: string,
        ) => Promise<IMusic.IMusicItem | null>;
    }

    export interface IPluginInstance extends IPluginDefine {
        /** 内部属性 */
        /** 插件路径 */
        _path: string;
    }

    type R = Required<IPluginInstance>;
    export type IPluginInstanceMethods = {
        [K in keyof R as R[K] extends (...args: any) => any ? K : never]: R[K];
    };

    /** 插件其他属性 */
    export type IPluginMeta = {
        order: number;
        userEnv: Record<string, string>;
    };
}
