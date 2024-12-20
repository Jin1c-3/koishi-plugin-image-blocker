import { Context, Schema, h, $ } from "koishi";
import {} from "@koishijs/cache";
import imghash from "imghash";
import { distance as leven } from "fastest-levenshtein";
import fs from "fs";
import path from "path";

export const name = "image-blocker";
export const inject = ["database", "cache"];

export interface Config {
  similarity: number;
  recall_flag: boolean;
  mute_flag: boolean;
  mute_time: number;
  cache_time: number;
}

export const Config: Schema<Config> = Schema.object({
  similarity: Schema.number()
    .role("slider")
    .min(0)
    .max(14)
    .default(3)
    .description(
      "相似度阈值，越小则越难判定为相似图片，越大则越容易判定为相似图片，不建议超过6"
    ),
  recall_flag: Schema.boolean().default(true).description("是否撤回相似图片"),
  mute_flag: Schema.boolean().default(false).description("是否禁言发送者"),
  mute_time: Schema.natural().description("禁言时长，单位：分钟").default(30),
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
  id: number;
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

export function apply(
  ctx: Context,
  { similarity, cache_time, recall_flag, mute_flag, mute_time }: Config
) {
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
      id: "unsigned",
      guild: "string",
      file_unique: "string",
    },
    {
      primary: ["id"],
      autoInc: true,
    }
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
      const guild_alredy_has = await ctx.database.get(
        "imageBlockerGuild",
        (row) =>
          $.and(
            $.eq(row.file_unique, img_to_add.filename.split(".")[0]),
            $.eq(row.guild, session.guildId)
          )
      );
      if (guild_alredy_has.length) {
        return session.text(".guild_alredy_has");
      }
      const pic_already_has = await ctx.database.get("imageBlockerHash", {
        file_unique: img_to_add.filename.split(".")[0],
      });
      if (!pic_already_has.length) {
        // 获取图片数据
        const buffer = Buffer.from(
          await ctx.http.get(img_to_add.src, { responseType: "arraybuffer" })
        );
        // 转存图片
        // const image = await sharp(buffer).png().toBuffer();
        const pic_name =
          (await ctx.database
            .select("imageBlockerHash")
            .execute((row) => $.max(row.pic))) + 1;
        const pic_path = path.join(root, `${pic_name}.png`);
        fs.writeFileSync(pic_path, buffer);
        // 获取图片hash
        const hash = await imghash.hash(pic_path);
        // 添加到数据库
        await ctx.database.create("imageBlockerHash", {
          pic: pic_name,
          file_unique: img_to_add.filename.split(".")[0],
          hash: hash,
        });
      }
      const id =
        (await ctx.database
          .select("imageBlockerGuild")
          .execute((row) => $.max(row.id))) + 1;
      await ctx.database.create("imageBlockerGuild", {
        id: id,
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
      await ctx.database.remove("imageBlockerGuild", (row) =>
        $.and(
          $.eq(row.file_unique, fq_pic.file_unique),
          $.eq(row.guild, session.guildId)
        )
      );
      return session.text(".del-success");
    });

  ctx.middleware(async (session, next) => {
    ctx = ctx.guild();
    const images_to_check = session.elements
      .filter((element) => element.type === "image" || element.type === "img")
      .map((element) => element.attrs);
    if (!images_to_check.length) {
      return next();
    }
    const fq_guild = (
      await ctx.database.get("imageBlockerGuild", (row) =>
        $.eq(row.guild, session.guildId)
      )
    ).map((row) => row.file_unique);
    if (!fq_guild.length) {
      return next();
    }
    if (
      images_to_check.some((i) => fq_guild.includes(i.filename.split(".")[0]))
    ) {
      if (recall_flag)
        await session.bot.deleteMessage(session.guildId, session.messageId);
      if (mute_flag)
        await session.bot.muteGuildMember(
          session.guildId,
          session.userId,
          mute_time * 60000
        );
      logger.info("found identical image");
      return;
    }
    const hashes_to_check = await Promise.all(
      images_to_check.map(async (img) => {
        try {
          let hash = await ctx.cache.get(
            "image-blocker",
            img.filename.split(".")[0]
          );
          if (!hash) {
            const buffer = Buffer.from(
              await ctx.http.get(img.src, { responseType: "arraybuffer" })
            );
            const root = path.join(
              ctx.baseDir,
              "data",
              "image-blocker",
              "cache"
            );
            if (!fs.existsSync(root)) {
              fs.mkdirSync(root, { recursive: true });
            }
            const tempFilePath = path.join(
              root,
              `${img.filename.split(".")[0]}.png`
            );
            await fs.promises.writeFile(tempFilePath, buffer); // 使用异步文件操作
            hash = await imghash.hash(tempFilePath);
            await ctx.cache.set(
              "image-blocker",
              img.filename.split(".")[0],
              hash,
              cache_time * 60 * 60 * 1000
            );
            await fs.promises.unlink(tempFilePath); // 使用异步文件操作
          }
          return hash;
        } catch (error) {
          logger.error("Error processing image: ", error);
          return null; // 确保数组长度一致
        }
      })
    );
    const fq_hashes = await ctx.database.get("imageBlockerHash", {
      file_unique: fq_guild,
    });
    for (const rule_hash of fq_hashes) {
      for (const now_hash of hashes_to_check) {
        const distance = leven(rule_hash.hash, now_hash);
        if (distance <= similarity) {
          logger.info("found similar image, distance: ", distance);
          if (recall_flag)
            await session.bot.deleteMessage(session.guildId, session.messageId);
          if (mute_flag)
            await session.bot.muteGuildMember(
              session.guildId,
              session.userId,
              mute_time * 60000
            );
          return;
        }
      }
    }
    return next();
  });
}
