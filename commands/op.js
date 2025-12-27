import { EmbedBuilder } from "discord.js";
import Balance from "../models/Balance.js";
import Progress from "../models/Progress.js";
import Inventory from "../models/Inventory.js";
import Pull from "../models/Pull.js";
import { fuzzyFindCard } from "../lib/cardEmbed.js";
import { cards } from "../cards.js";
import Quest from "../models/Quest.js";

// This file implements prefix-only owner commands. Slash command registration is handled by `commands/owner.js`.

function isOwner(user, client) {
  const env = process.env.OWNER_ID;
  if (env && user.id === env) return true;
  try {
    if (client && client.application && client.application.owner) {
      const owner = client.application.owner;
      if (typeof owner === 'string') return user.id === owner;
      if (owner.id) return user.id === owner.id;
    }
  } catch (e) {}
  return false;
}

export async function execute(interactionOrMessage, client) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  if (!isOwner(user, client)) {
    const reply = "Only the bot owner can use this command.";
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  let sub = null;
  let group = null;
  if (isInteraction) {
    // when using subcommand groups: getSubcommandGroup, getSubcommand
    try { group = interactionOrMessage.options.getSubcommandGroup(); } catch (e) { group = null; }
    try { sub = interactionOrMessage.options.getSubcommand(); } catch (e) { sub = null; }
  } else {
    // support: `op user <@id>` quick owner-only profile view
    const rawParts = interactionOrMessage.content.trim().split(/\s+/);
    if ((rawParts[1] || "").toLowerCase() === "user") {
      const m = rawParts[2] ? rawParts[2].replace(/[^0-9]/g, "") : null;
      const target = m ? { id: m, username: rawParts[2] } : interactionOrMessage.author;
      const userId = target.id;
      const [bal, prog, pullDoc, inv] = await Promise.all([
        Balance.findOne({ userId }),
        Progress.findOne({ userId }),
        Pull.findOne({ userId }),
        Inventory.findOne({ userId })
      ]);
      const level = (bal && (bal.level || 0)) || 0;
      const xp = (bal && (bal.xp || 0)) || 0;
      const xpToNext = 100 - (xp % 100 || 0);
        const bar = (function(){ const pct = Math.max(0, Math.min(1, (xp%100)/100)); const filled = Math.round(pct*20); const empty = 20-filled; const f='▮', e='▯'; return f.repeat(filled) + e.repeat(empty) + ` ${Math.round(pct*100)}%`; })();
      const wealth = (bal && bal.amount) || 0;
      const higher = await Balance.countDocuments({ amount: { $gt: wealth } });
      const globalRank = higher + 1;
      const teamArr = (prog && Array.isArray(prog.team) ? prog.team : []);
      let avgPower = 0; let teamNames = [];
      if (teamArr.length > 0){ let sum=0, found=0; for (const cid of teamArr){ const c = cards.find(x=>x.id===cid); if (c){ sum+=c.power||0; found++; teamNames.push(`${c.name} (${c.rank})`); } } avgPower = found ? Math.round(sum/found) : 0; }
      const totalPulls = (pullDoc && (pullDoc.totalPulls || 0)) || 0;
      const cardMap = prog && prog.cards ? (prog.cards instanceof Map ? Object.fromEntries(prog.cards) : prog.cards) : {};
      const uniqueCards = Object.keys(cardMap || {}).length;
      let totalCardsCount=0, totalLevels=0; for(const k of Object.keys(cardMap||{})){ const e=cardMap[k]||{}; totalCardsCount += e.count||0; totalLevels += e.level||0; }
      const avgCardLevel = uniqueCards ? (Math.round((totalLevels/uniqueCards)*100)/100) : 0;
      const embed = new EmbedBuilder()
        .setColor(0xFFFFFF)
        .setTitle(`${target.username || target.id}`)
        .setDescription(`Level ${level} • XP to next: ${xpToNext}\n${bar}\n\n` +
          `**Wealth:** ${wealth}¥ • **Global Rank:** #${globalRank}\n` +
          `**Team (avg power):** ${teamNames.length ? teamNames.join(", ") + ` • ${avgPower}` : "None"}\n` +
          `**Statistics:**\n• Total pulls: ${totalPulls}\n• Unique cards: ${uniqueCards}\n• Total cards owned: ${totalCardsCount}`)
        .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() });
        // (How to level up section intentionally omitted per request)
      return channel.send({ embeds: [embed] });
    }
    // message invocation: expect `op owner <sub> ...`
    const parts = interactionOrMessage.content.trim().split(/\s+/);
    if ((parts[1] || "").toLowerCase() !== "owner" && (parts[1] || "").toLowerCase() !== "ownercmds") {
      const reply = "Usage: op owner <give-money|give-card|give-item|reset> ... or op ownercmds";
      return channel.send(reply);
    }

    // support: `op ownercmds` and `op owner <sub>` message forms
    if ((parts[1] || "").toLowerCase() === "ownercmds") {
      group = null;
      sub = "ownercmds";
      interactionOrMessage._rawParts = parts;
    } else {
      group = "owner";
      // support: op owner give item ...  or op owner give-card ...
      let rawSub = (parts[2] || "").toLowerCase();
      if (rawSub === "give" && parts[3]) rawSub = `give-${parts[3].toLowerCase()}`; // e.g. give card => give-card or give item => give-item
      sub = rawSub;
      interactionOrMessage._rawParts = parts;
    }
  }

  if (group !== "owner") {
    // allow top-level ownercmds
    if (sub === "ownercmds") {
      const embed = new EmbedBuilder()
        .setTitle("Owner Commands")
        .setColor(0xFFFFFF)
        .setDescription(
          "Available owner commands:\n\n" +
          "• `op owner give-item <resettoken|chestB|chestA|chestS> <amount> <@user>` — give items\n" +
          "• `op owner give-card <card id or name> <@user>` — give a card to user\n" +
          "• `op owner give-money <amount> <@user>` — give money to user\n" +
          "• `op owner reset <@user>` — reset a user's data\n\n" +
          "Usage: slash: `/op owner <subcommand>` or message: `op owner <subcommand> ...`"
        )
        .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() });

      if (isInteraction) return interactionOrMessage.reply({ embeds: [embed], ephemeral: true });
      return channel.send({ embeds: [embed] });
    }

    const reply = "This command only supports the `owner` subcommand group: `/op owner <sub>` or the `ownercmds` subcommand.";
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  if (sub === "give-money") {
    let target, amount;
    if (isInteraction) {
      target = interactionOrMessage.options.getUser("user");
      amount = interactionOrMessage.options.getNumber("amount");
    } else {
      const parts = interactionOrMessage._rawParts || interactionOrMessage.content.trim().split(/\s+/);
      const argStart = (parts[2] && parts[2].toLowerCase() === 'give') ? 4 : 3;
      amount = parseFloat(parts[argStart] || "0") || 0;
      const targetToken = parts[parts.length - 1] || null;
      target = targetToken ? { id: targetToken.replace(/[^0-9]/g, ""), username: targetToken } : null;
    }
    let bal = await Balance.findOne({ userId: target.id });
    if (!bal) { bal = new Balance({ userId: target.id, amount: 0, resetTokens: 0 }); }
    bal.amount = (bal.amount || 0) + (amount || 0);
    await bal.save();
    const embed = new EmbedBuilder().setTitle("Money Given").setDescription(`Gave ${amount}¥ to <@${target.id}>`).setColor(0x2ecc71);
    if (isInteraction) return interactionOrMessage.reply({ embeds: [embed], ephemeral: true }); else return channel.send({ embeds: [embed] });
  }

  if (sub === "give-card") {
    let target, cardQ;
    if (isInteraction) {
      target = interactionOrMessage.options.getUser("user");
      cardQ = interactionOrMessage.options.getString("card");
    } else {
      const parts = interactionOrMessage._rawParts || interactionOrMessage.content.trim().split(/\s+/);
      const argStart = (parts[2] && parts[2].toLowerCase() === 'give') ? 4 : 3;
      // assume last token is mention/ID
      const targetToken = parts[parts.length - 1];
      target = targetToken ? { id: targetToken.replace(/[^0-9]/g, ""), username: targetToken } : null;
      cardQ = parts.slice(argStart, parts.length - 1).join(" ") || parts[argStart] || "";
    }
    const card = fuzzyFindCard(cardQ) || cards.find(c => c.id === cardQ) || null;
    if (!card) {
      const reply = `Card "${cardQ}" not found.`;
      if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true }); else return channel.send(reply);
    }
    let prog = await Progress.findOne({ userId: target.id });
    if (!prog) prog = new Progress({ userId: target.id, cards: {} });
    const cardsMap = prog.cards instanceof Map ? prog.cards : new Map(Object.entries(prog.cards || {}));
    const entry = cardsMap.get(card.id) || { count: 0, xp: 0, level: 0, acquiredAt: Date.now() };
    entry.count = (entry.count || 0) + 1;
    cardsMap.set(card.id, entry);
    prog.cards = cardsMap;
    prog.markModified('cards');
    await prog.save();
    const embed = new EmbedBuilder().setTitle("Card Given").setDescription(`Gave **${card.name}** to <@${target.id}>`).setColor(0x3498db);
    if (isInteraction) return interactionOrMessage.reply({ embeds: [embed], ephemeral: true }); else return channel.send({ embeds: [embed] });
  }

  if (sub === "give-item") {
    let target, item, amount;
    if (isInteraction) {
      target = interactionOrMessage.options.getUser("user");
      item = interactionOrMessage.options.getString("item");
      amount = interactionOrMessage.options.getInteger("amount") || 1;
    } else {
      const parts = interactionOrMessage._rawParts || interactionOrMessage.content.trim().split(/\s+/);
      const argStart = (parts[2] && parts[2].toLowerCase() === 'give') ? 4 : 3;
      item = parts[argStart];
      amount = parseInt(parts[argStart + 1] || "1", 10) || 1;
      const targetToken = parts[parts.length - 1] || null;
      target = targetToken ? { id: targetToken.replace(/[^0-9]/g, ""), username: targetToken } : null;
    }

    if (!target || !target.id) {
      const reply = "Target user not specified or invalid.";
      if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true }); else return channel.send(reply);
    }

    const t = String(item || "").toLowerCase();
    if (t === "resettoken" || t === "resettokens" || t === "reset") {
      let bal = await Balance.findOne({ userId: target.id });
      if (!bal) bal = new Balance({ userId: target.id, amount: 0, resetTokens: 0 });
      bal.resetTokens = (bal.resetTokens || 0) + (amount || 0);
      await bal.save();
      const embed = new EmbedBuilder().setTitle("Items Given").setDescription(`Gave ${amount} Reset Token(s) to <@${target.id}>`).setColor(0x9b59b6);
      if (isInteraction) return interactionOrMessage.reply({ embeds: [embed], ephemeral: true }); else return channel.send({ embeds: [embed] });
    }

    const chestMatch = t.match(/chest\s*[_-]?([a-z0-9]+)/i) || t.match(/^([a-z0-9]+)chest$/i) || t.match(/^([a-z0-9])$/i);
    let rank = null;
    if (chestMatch) rank = chestMatch[1].toUpperCase();
    else if (/^[a-z0-9]$/i.test(t)) rank = t.toUpperCase();

    if (rank) {
      let inv = await Inventory.findOne({ userId: target.id });
      if (!inv) inv = new Inventory({ userId: target.id, items: {}, chests: { C:0,B:0,A:0,S:0 }, xpBottles:0 });
      inv.chests = inv.chests || { C:0,B:0,A:0,S:0 };
      inv.chests[rank] = (inv.chests[rank] || 0) + (amount || 0);
      await inv.save();
      const embed = new EmbedBuilder().setTitle("Items Given").setDescription(`Gave ${amount}× ${rank} Chest(s) to <@${target.id}>`).setColor(0xf1c40f);
      if (isInteraction) return interactionOrMessage.reply({ embeds: [embed], ephemeral: true }); else return channel.send({ embeds: [embed] });
    }

    const reply = "Unknown item type. Use `resettoken` or `chestB|chestA|chestS` etc.";
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true }); else return channel.send(reply);
  }

  if (sub === "reset") {
    let target;
    if (isInteraction) target = interactionOrMessage.options.getUser("user");
    else {
      const parts = interactionOrMessage._rawParts || interactionOrMessage.content.trim().split(/\s+/);
      target = parts[3] ? { id: parts[3].replace(/[^0-9]/g, ""), username: parts[3] } : null;
    }
    await Promise.all([
      Balance.deleteOne({ userId: target.id }),
      Progress.deleteOne({ userId: target.id }),
      Inventory.deleteOne({ userId: target.id }),
      Pull.deleteOne({ userId: target.id }),
      Quest.updateMany({}, { $unset: { [`progress.${target.id}`]: "" } })
    ]);
    const embed = new EmbedBuilder().setTitle("User Reset").setDescription(`Reset data for <@${target.id}>`).setColor(0xe74c3c);
    if (isInteraction) return interactionOrMessage.reply({ embeds: [embed], ephemeral: true }); else return channel.send({ embeds: [embed] });
  }

  const reply = "Unknown subcommand.";
  if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true }); else return channel.send(reply);
}

export const description = "Owner / admin commands (give money/card/items, reset user)";

export const aliases = ["ownercmds"];

