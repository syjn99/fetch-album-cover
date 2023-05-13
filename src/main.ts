import { Client } from '@notionhq/client';
import { config } from 'dotenv';
import { LAST_FM_ENDPOINT, TRACK_GET_INFO, TRACK_SEARCH } from './constants.js';

const propertyType = [
  'title',
  'date',
  'checkbox',
  'multi_select',
  'rich_text',
] as const;

type PropertyType = (typeof propertyType)[number];

type Property = {
  propertyId: string;
  type: PropertyType;
  content: object | boolean;
};

interface Page {
  pageId: string;
  properties: {
    [name: string]: Property;
  };
}

type TrackInfo = {
  title: string;
  artist: string;
  albumTitle?: string;
  albumCover?: string;
  releaseDate?: string;
};

config();

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;
const LAST_FM_API_KEY = process.env.LAST_FM_API_KEY;

const pageIdToDoneMap: { [pageId: string]: boolean } = {};

function getPropertyValue(page: Page, propertyName: string): any {
  const property: Property = page.properties[propertyName];
  const propertyType = property.type;

  const result = property[propertyType];

  if (typeof result === 'boolean') {
    return result;
  } else if (result.length > 0) {
    return result[0].plain_text;
  }

  return null;
}

async function getPages(): Promise<Page[]> {
  const database = [];
  let cursor = undefined;

  const shouldContinue = true;
  while (shouldContinue) {
    const { results, next_cursor } = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
    });
    database.push(...results);
    if (!next_cursor) {
      break;
    }
    cursor = next_cursor;
  }

  const pages = [];

  for (const data of database) {
    pages.push({
      pageId: data.id,
      properties: data.properties,
    });
  }

  return pages;
}

async function findPageToUpdate(pages: Page[]): Promise<Page[]> {
  return pages.filter((page) => {
    const title = getPropertyValue(page, '제목');
    const artistName = getPropertyValue(page, 'Artist (검색용)');

    if (!title || !artistName) {
      return false;
    }

    return pageIdToDoneMap[page.pageId] === false;
  });
}

async function fetchAndUpdatePage(toBeUpdatedPages: Page[]) {
  for (const page of toBeUpdatedPages) {
    const title = getPropertyValue(page, '제목');
    const artistName = getPropertyValue(page, 'Artist (검색용)');

    const keyword = `${title} ${artistName}`;

    const searchResult = await fetch(
      `${LAST_FM_ENDPOINT}?method=${TRACK_SEARCH}&api_key=${LAST_FM_API_KEY}&format=json&track=${keyword}&limit=1`,
    )
      .then((res) => res.json())
      .then((json) => {
        const { name, artist } = json.results.trackmatches.track[0];
        return {
          title: name,
          artist: artist,
        };
      });

    const trackInfoResult: TrackInfo = await fetch(
      `${LAST_FM_ENDPOINT}?method=${TRACK_GET_INFO}&api_key=${LAST_FM_API_KEY}&format=json&track=${searchResult.title}&artist=${searchResult.artist}`,
    )
      .then((res) => res.json())
      .then((json) => {
        console.log(json);
        const rawTrackInfo = json.track;

        console.log(rawTrackInfo);

        const title = rawTrackInfo.name;
        const artist = rawTrackInfo.artist.name;

        const hasAlbumInfo = rawTrackInfo.album;
        const hasReleaseDate = rawTrackInfo.wiki;

        const result = {
          title,
          artist,
        };

        if (hasAlbumInfo) {
          result['albumTitle'] = rawTrackInfo.album.title;
          result['albumCover'] = rawTrackInfo.album.image[3]['#text'];
        }

        if (hasReleaseDate) {
          result['releaseDate'] = rawTrackInfo.wiki.published;
        }

        return result;
      });

    const releaseProperty = trackInfoResult.releaseDate
      ? {
          date: {
            start: new Date(trackInfoResult.releaseDate).toISOString(),
          },
        }
      : {
          date: {
            start: new Date().toISOString(),
          },
        };

    await notion.pages.update({
      page_id: page.pageId,
      properties: {
        제목: {
          title: [
            {
              text: {
                content: trackInfoResult.title,
              },
            },
          ],
        },
        Artist: {
          multi_select: [
            {
              name: trackInfoResult.artist,
            },
          ],
        },
        Album: {
          rich_text: [
            {
              text: {
                content: trackInfoResult.albumTitle
                  ? trackInfoResult.albumTitle
                  : 'No Album Searched',
              },
            },
          ],
        },
        Release: releaseProperty,
        날짜: {
          date: {
            start: new Date().toISOString(),
          },
        },
        '완료!': {
          checkbox: true,
        },
      },
    });

    if (trackInfoResult.albumCover) {
      await notion.blocks.children.append({
        block_id: page.pageId,
        children: [
          {
            object: 'block',
            type: 'image',
            image: {
              type: 'external',
              external: {
                url: trackInfoResult.albumCover,
              },
            },
          },
        ],
      });
    }

    pageIdToDoneMap[page.pageId] = true;
  }
}

async function init(): Promise<Page[]> {
  const pages = await getPages();
  for (const page of pages) {
    const isDone = getPropertyValue(page, '완료!');
    pageIdToDoneMap[page.pageId] = isDone;
  }
  return pages;
}

async function main() {
  const pages = await init();
  const toBeUpdatedPages = await findPageToUpdate(pages);
  await fetchAndUpdatePage(toBeUpdatedPages);
}

main();
