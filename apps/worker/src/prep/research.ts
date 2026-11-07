import { htmlToText } from '../discovery/text';
import type { Http } from '@wma/discovery';

const MAX_BOARD_CHARS = 6000;

export interface Research {
  /** Plain text of the company's public board page; null when it could not be read. */
  boardText: string | null;
}

const isHttp = (url: string) => {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
};

/**
 * The only public research the plan uses: the company's own job board page. A page that cannot
 * be read is not an error; the plan then rests on the posting alone.
 */
export async function gatherResearch(http: Http, boardUrl: string | null): Promise<Research> {
  if (!boardUrl || !isHttp(boardUrl)) return { boardText: null };
  try {
    const res = await http.get(boardUrl, { headers: { accept: 'text/html' } });
    if (!res.ok) return { boardText: null };
    const text = htmlToText(res.text()).slice(0, MAX_BOARD_CHARS);
    return { boardText: text || null };
  } catch {
    return { boardText: null };
  }
}
