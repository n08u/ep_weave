import HTMLParser, { Node } from "node-html-parser";
import { SearchEngine, PadType } from "ep_search/setup";
import removeMdBase from "remove-markdown";
import { searchHashes, updateHash } from "./hash";
import { logPrefix } from "../util/log";
import { escapeForText } from "../static/js/result";

const api = require("ep_etherpad-lite/node/db/API");
const db = require("ep_etherpad-lite/node/db/DB").db;
const { decode, encode } = require("he");

const MAX_PAGES = 10000;

type TitleUpdateResult = {
  oldTitle: string;
  newTitle: string;
  hashes: {
    updates: string[];
  };
};

type HashUpdate = {
  oldTitle: string;
  newTitle: string;
};

type HashUpdateCommand = {
  id: string;
  updates: HashUpdate[];
};

function removeMd(baseText: string) {
  const text = removeMdBase(baseText);
  const m = text.match(/^\*+(.+)$/);
  if (m) {
    return m[1];
  }
  return text;
}

export function extractTitle(padData: PadType) {
  const lines = (padData.atext || {}).text.split("\n");
  return removeMd(lines[0]);
}

function traverseNodes(node: Node, handler: (node: Node) => void) {
  handler(node);
  (node.childNodes || []).forEach((child: Node) => {
    handler(child);
    traverseNodes(child, handler);
  });
}

function replaceTitle(text: string, oldtitle: string, newtitle: string) {
  return text.replace(oldtitle, newtitle);
}

function replaceTitleHtml(
  html: string,
  oldtitle: string,
  newtitle: string
): string | null {
  let html_ = html;
  const m = html.match(/^\<\!DOCTYPE\s+HTML\>(.+)$/);
  if (m) {
    html_ = m[1];
  }
  const root = HTMLParser.parse(html_);
  let replaced = false;
  traverseNodes(root, (node) => {
    if (node.nodeType !== 3 /* Node.TEXT_NODE */) {
      return;
    }
    if (replaced) {
      return;
    }
    const decodedText = decode(node.rawText);
    if (!decodedText.includes(oldtitle)) {
      return;
    }
    replaced = true;
    const replacedText = replaceTitle(decodedText, oldtitle, newtitle);
    console.info(logPrefix, "Title replaced", decodedText, replacedText);
    node.rawText = encode(replacedText);
  });
  if (!replaced) {
    console.warn(logPrefix, "Title not found in HTML", oldtitle, html);
    return null;
  }
  return root.toString();
}

async function updateTitleContent(
  searchEngine: SearchEngine,
  pad: PadType,
  oldTitle: string,
  newTitle: string
): Promise<TitleUpdateResult> {
  console.info(logPrefix, "Update title", pad.id, oldTitle, newTitle);
  const { html } = await api.getHTML(pad.id);
  const replacedHtml = replaceTitleHtml(html, oldTitle, newTitle);
  if (replacedHtml === null) {
    console.warn(logPrefix, "Title not found in HTML", oldTitle, newTitle);
    const updates = await searchHashes(searchEngine, oldTitle);
    return {
      oldTitle,
      newTitle,
      hashes: {
        updates: updates.map((pad) => pad.id),
      },
    };
  }
  await api.setHTML(pad.id, replacedHtml);

  const updates = await searchHashes(searchEngine, oldTitle);
  return {
    oldTitle,
    newTitle,
    hashes: {
      updates: updates.map((pad) => pad.id),
    },
  };
}

async function updateTitle(
  searchEngine: SearchEngine,
  pad: PadType,
  oldTitle: string,
  newTitle: string
): Promise<TitleUpdateResult | null> {
  console.debug(logPrefix, "Updating", pad);
  const oldChildTitle = pad.title;
  if (!oldChildTitle.startsWith(`${oldTitle}/`)) {
    console.warn(
      logPrefix,
      `Child pad title does not start with parent title: ${oldChildTitle}`
    );
    return null;
  }
  const newChildTitle = newTitle + oldChildTitle.substring(oldTitle.length);
  return await updateTitleContent(
    searchEngine,
    pad,
    oldChildTitle,
    newChildTitle
  );
}

function getUpdatedPads(
  titlesUpdates: TitleUpdateResult[]
): HashUpdateCommand[] {
  const allHashes = titlesUpdates.reduce((acc, update) => {
    return acc.concat(update.hashes.updates);
  }, [] as string[]);
  const uniqueHashes = Array.from(new Set(allHashes));
  return uniqueHashes.map((id) => {
    const updates = titlesUpdates.filter((update) =>
      update.hashes.updates.includes(id)
    );
    return {
      id,
      updates,
    };
  });
}

export async function updateTitles(
  searchEngine: SearchEngine,
  oldTitle: string,
  newTitle: string
) {
  if (oldTitle.trim().length === 0 || newTitle.trim().length === 0) {
    throw new Error("Title must not be empty");
  }
  const childPadsQuery = `title:${escapeForText(`${oldTitle}/`)}*`;
  const results = await searchEngine.search(childPadsQuery, {
    rows: MAX_PAGES + 1,
  });
  const { docs: childPads, numFound } = results;
  if (numFound >= MAX_PAGES) {
    console.warn(
      logPrefix,
      `Too many child pads found for ${oldTitle}: ${numFound}`
    );
  }
  const updates = await Promise.all(
    childPads.map((pad: PadType) =>
      updateTitle(searchEngine, pad, oldTitle, newTitle)
    )
  );
  const titlesUpdates = updates.filter(
    (update) => update !== null
  ) as TitleUpdateResult[];
  const hashes = await searchHashes(searchEngine, oldTitle);
  const hashUpdates = await Promise.all(
    getUpdatedPads(
      titlesUpdates.concat([
        {
          oldTitle,
          newTitle,
          hashes: {
            updates: hashes.map((pad) => pad.id),
          },
        },
      ])
    ).map((command) => updateHash(command.id, command.updates))
  );
  return {
    titles: updates,
    hashes: hashUpdates,
  };
}
