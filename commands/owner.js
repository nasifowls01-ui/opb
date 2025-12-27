import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import Balance from "../models/Balance.js";
import Progress from "../models/Progress.js";
import Inventory from "../models/Inventory.js";
import Pull from "../models/Pull.js";
import { fuzzyFindCard } from "../lib/cardEmbed.js";
import { cards } from "../cards.js";
import Quest from "../models/Quest.js";

export const data = new SlashCommandBuilder()
  .setName("owner")
  .setDescription("Owner / admin commands for the bot")
  .addSubcommand(s => s.setName("ownercmds").setDescription("Show owner commands list"))
  .addSubcommandGroup(g => g.setName("owner").setDescription("Owner-only commands")
    .addSubcommand(s => s.setName("give-money").setDescription("Give a user money").addUserOption(o => o.setName("user").setDescription("Target user to receive money").setRequired(true)).addNumberOption(o => o.setName("amount").setDescription("Amount of money to give").setRequired(true)))
    .addSubcommand(s => s.setName("give-item").setDescription("Give an item to a user").addUserOption(o => o.setName("user").setDescription("Target user to receive the item").setRequired(true)).addStringOption(o => o.setName("item").setRequired(true).setDescription("resettoken | chestB | chestA | chestS etc.")).addIntegerOption(o => o.setName("amount").setDescription("Amount of the item to give").setRequired(true)))
    .addSubcommand(s => s.setName("give-card").setDescription("Give a card to a user").addUserOption(o => o.setName("user").setDescription("Target user to receive the card").setRequired(true)).addStringOption(o => o.setName("card").setDescription("Card name or id to give").setRequired(true)))
    .addSubcommand(s => s.setName("reset").setDescription("Reset a user's data").addUserOption(o => o.setName("user").setDescription("Target user to reset").setRequired(true))));

export const aliases = ["ownercmds"];

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
    // message invocation: expect `op owner <sub> ...` or `op ownercmds`
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
          "Usage: slash: `/owner owner <subcommand>` or message: `op owner <subcommand> ...`"
        )
        .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() });

      if (isInteraction) return interactionOrMessage.reply({ embeds: [embed], ephemeral: true });
      return channel.send({ embeds: [embed] });
    }

    const reply = "This command only supports the `owner` subcommand group: `/owner owner <sub>` or the `ownercmds` subcommand.";
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
      const targetId = targetToken ? targetToken.replace(/[^0-9]/g, "") : null;
      if (!targetId || targetId === "") {
        return interactionOrMessage.channel.send("Please mention or provide a valid user ID.");
      }
      target = { id: targetId, username: targetToken };
      cardQ = parts.slice(argStart, parts.length - 1).join(" ") || parts[argStart] || "";
    }
    
    if (!target || !target.id) {
      const reply = `Invalid user specified.`;
      if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true }); else return interactionOrMessage.channel.send(reply);
    }
    
    const card = fuzzyFindCard(cardQ) || cards.find(c => c.id === cardQ) || null;
    if (!card) {
      const reply = `Card "${cardQ}" not found.`;
      if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true }); else return interactionOrMessage.channel.send(reply);
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
    if (!target || !target.id) {
      const reply = "Target user not specified or invalid.";
      if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true }); else return channel.send(reply);
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
