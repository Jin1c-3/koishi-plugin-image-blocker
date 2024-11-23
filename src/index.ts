import { Context, Schema, h, $ } from "koishi";
import {} from "@koishijs/cache";
import imghash from "imghash";
import leven from "leven";
import fs from "fs";
import path from "path";
import sharp from "sharp";

export const name = "image-blocker";
export const inject = ["database", "cache"];

export interface Config {
  similarity: number;
  cache_time: number;
}

export const Config: Schema<Config> = Schema.object({
  similarity: Schema.number()
    .role("slider")
    .min(0)
    .max(14)
    .default(2)
    .description(
      "相似度阈值，越小则越难判定为相似图片，越大则越容易判定为相似图片，不建议超过6"
    ),
  cache_time: Schema.natural()
    .description("图片哈希值的缓存时间，单位：小时")
    .default(24 * 7),
});

interface imageBlockerHashTable {
  file_unique: string;
  pic: number;
  hash: string;
}

// 多对多关系
interface imageBlockerGuildTable {
  guild: string;
  file_unique: string;
}

declare module "koishi" {
  interface Tables {
    imageBlockerHash: imageBlockerHashTable;
    imageBlockerGuild: imageBlockerGuildTable;
  }
}

// 扩展 foo 表
declare module "@koishijs/cache" {
  interface Tables {
    "image-blocker": string;
  }
}

export function apply(ctx: Context, { similarity, cache_time }: Config) {
  ctx.i18n.define("zh-CN", require("./locales/zh_CN"));
  const logger = ctx.logger("image-blocker");

  ctx.model.extend(
    "imageBlockerHash",
    {
      file_unique: "string",
      pic: "unsigned",
      hash: "string",
    },
    { primary: ["file_unique"] }
  );
  ctx.model.extend(
    "imageBlockerGuild",
    {
      guild: "string",
      file_unique: "string",
    },
    { primary: ["file_unique", "guild"] }
  );

  ctx
    .command("image-blocker", {
      authority: 3,
    })
    .alias("违禁图", { args: ["add"] });

  ctx
    .command("image-blocker")
    .subcommand(".list")
    .alias(".列表")
    .option("page", "-p <num:number>", { fallback: 1 })
    .action(async ({ session, options }) => {
      const images = await ctx.database
        .select("imageBlockerGuild")
        .where({ guild: session.guildId })
        .limit(5)
        .offset((options.page - 1) * 5)
        .execute();
      if (!images.length) {
        return session.text(".has-no-image");
      }
      const root = path.join(ctx.baseDir, "data", name);
      const fq_pics = await ctx.database.get("imageBlockerHash", {
        file_unique: images.map((i) => i.file_unique),
      });
      for (let fq_pic of fq_pics) {
        const pic_path = path.join(root, `${fq_pic.pic}.png`);
        await session.send(
          h(
            "p",
            `序号：${fq_pic.pic}`,
            h("p", `文件识别符：${fq_pic.file_unique}`, h.image(pic_path))
          )
        );
      }
    });

  ctx
    .command("image-blocker")
    .subcommand(".add")
    .alias(".添加")
    .action(async ({ session }) => {
      await session.send(session.text(".image-to-add"));
      const reply = h.parse(await session.prompt());
      if (reply[0].type !== "image" && reply[0].type !== "img") {
        return await session.send(session.text(".bad-image"));
      }
      const img_to_add = reply[0].attrs;
      // 建文件夹
      const root = path.join(ctx.baseDir, "data", name);
      if (!fs.existsSync(root)) {
        fs.mkdirSync(root, { recursive: true });
      }
      const alredy_has = await ctx.database.get("imageBlockerHash", {
        file_unique: img_to_add.filename.split(".")[0],
      });
      if (alredy_has.length) {
        return session.text(".already-has");
      }
      // 获取图片数据
      const buffer = Buffer.from(
        await ctx.http.get(img_to_add.src, { responseType: "arraybuffer" })
      );
      // 转存图片
      const image = await sharp(buffer).png().toBuffer();
      const pic_name =
        (await ctx.database
          .select("imageBlockerHash")
          .execute((row) => $.max(row.pic))) + 1;
      const pic_path = path.join(root, `${pic_name}.png`);
      fs.writeFileSync(pic_path, image);
      // 获取图片hash
      const hash = await imghash.hash(image);
      // 添加到数据库
      await ctx.database.create("imageBlockerHash", {
        pic: pic_name,
        file_unique: img_to_add.filename.split(".")[0],
        hash: hash,
      });
      await ctx.database.create("imageBlockerGuild", {
        guild: session.guildId,
        file_unique: img_to_add.filename.split(".")[0],
      });
      return session.text(".success-to-add");
    });

  ctx
    .command("image-blocker")
    .subcommand(".del")
    .alias(".删除")
    .action(async ({ session }) => {
      await session.send(session.text(".pre-del"));
      const reply = h.parse(await session.prompt());
      if (reply[0].type !== "text") {
        return await session.send(session.text(".text-only"));
      }
      const num = parseInt(reply[0].attrs.content);
      console.log(num);
      const fq_pics = await ctx.database.get("imageBlockerHash", (row) =>
        $.eq(row.pic, num)
      );
      if (!fq_pics.length) {
        return await session.send(session.text(".non-exist"));
      }
      const fq_pic = fq_pics[0];
      await ctx.database.remove("imageBlockerHash", {
        file_unique: fq_pic.file_unique,
      });
      await ctx.database.remove("imageBlockerGuild", (row) =>
        $.and(
          $.eq(row.file_unique, fq_pic.file_unique),
          $.eq(row.guild, session.guildId)
        )
      );
      return session.text(".del-success");
    });

  ctx.on("message", async (session) => {
    ctx = ctx.platform("onebot").guild();
    const images_to_check = session.elements
      .filter((element) => element.type === "image" || element.type === "img")
      .map((element) => element.attrs);
    if (!images_to_check.length) {
      return;
    }
    const fq_guild = await ctx.database.get("imageBlockerGuild", (row) =>
      $.eq(row.guild, session.guildId)
    );
    if (
      images_to_check.some((i) => fq_guild.includes(i.filename.split(".")[0]))
    ) {
      return;
    }
    const hashes_to_check = await Promise.all(
      images_to_check.map(async (img) => {
        let hash = await ctx.cache.get("image-blocker", img.file_unique);
        if (!hash) {
          const buffer = Buffer.from(
            await ctx.http.get(img.src, { responseType: "arraybuffer" })
          );
          const image = await sharp(buffer).png().toBuffer();
          const tempFilePath = path.join(ctx.baseDir, "temp", `${img.file_unique}.png`);
          fs.writeFileSync(tempFilePath, image);
          hash = await imghash.hash(tempFilePath);
          ctx.cache.set(
            "image-blocker",
            img.filename.split(".")[0],
            hash,
            cache_time * 60 * 60 * 1000
          );
          fs.unlinkSync(tempFilePath);
        }
        return hash;
      })
    );
    const fq_hashes = await ctx.database.get("imageBlockerHash", {
      file_unique: fq_guild.map((fg) => fg.file_unique),
    });
    for (const rule_hash of fq_hashes) {
      for (const now_hash of hashes_to_check) {
        const distance = leven(rule_hash.hash, now_hash);
        if (distance <= similarity) {
          logger.info("found similar image, distance: ", distance);
          await session.bot.deleteMessage(session.guildId, session.messageId);
          return;
        }
      }
    }
  });
}
