import { EmbedBuilder } from 'discord.js';
import Progress from '../models/Progress.js';
import Pull from '../models/Pull.js';
import Balance from '../models/Balance.js';
import Inventory from '../models/Inventory.js';
import { fuzzyFindCard } from '../lib/cardEmbed.js';

const OWNER_ID = "1257718161298690119";

export default {
  data: { name: "mod" },
  
  async execute(message, client) {
    if (!message || typeof message.content !== "string") return;
    
    const authorId = message.author?.id;
    if (authorId !== OWNER_ID) {
      await message.channel.send("❌ Only the bot owner can use mod commands.");
      return;
    }

    const args = message.content.trim().split(/\s+/).slice(1);
    if (args.length === 0) {
      await message.channel.send("❌ Please specify a mod command.");
      return;
    }

    const subcommand = args[0].toLowerCase();

    switch (subcommand) {
      case 'list': {
        const embed = new EmbedBuilder()
          .setTitle("Owner Commands")
          .setColor(0x3498db)
          .setDescription("Quick owner utilities for managing user data and balances")
          .addFields(
            { name: "!mod give", value: "Give a card to a user", inline: true },
            { name: "!mod setlevel", value: "Set a card's level for a user", inline: true },
            { name: "!mod setbal", value: "Set a user's balance", inline: true },
            { name: "!mod givebal", value: "Give balance to a user", inline: true },
            { name: "!mod takebal", value: "Take balance from a user", inline: true },
            { name: "!mod datareset", value: "Reset a user's data", inline: true }
          )
          .setFooter({ text: "Note: commands use flexible name matching for cards" });

        await message.channel.send({ embeds: [embed] });
        break;
      }

      case 'datareset': {
        const target = message.mentions.users.first();
        if (!target) {
          await message.channel.send("❌ Please mention a user to reset.");
          return;
        }

        await Progress.deleteOne({ userId: target.id });
        await Pull.deleteOne({ userId: target.id });
        await Balance.deleteOne({ userId: target.id });
        await Inventory.deleteOne({ userId: target.id });
        await message.channel.send(`Reset data for <@${target.id}> (Progress, Pull window, Balance, Inventory).`);
        break;
      }

      case 'give': {
        if (args.length < 3) {
          await message.channel.send("❌ Usage: !mod give <card_name> @user");
          return;
        }

        const target = message.mentions.users.first();
        if (!target || !target.id) {
          await message.channel.send("❌ Please mention a valid user to give the card to.");
          return;
        }

        const cardName = args.slice(1, -1).join(" ");
        const card = fuzzyFindCard(cardName);
        if (!card) {
          await message.channel.send(`❌ Card not found for query: ${cardName}`);
          return;
        }

        let prog = await Progress.findOne({ userId: target.id });
        if (!prog) prog = new Progress({ userId: target.id, cards: {} });
        const cardsMap = prog.cards instanceof Map ? prog.cards : new Map(Object.entries(prog.cards || {}));
        const entry = cardsMap.get(card.id) || { count: 0, xp: 0, level: 0 };
        entry.count = (entry.count || 0) + 1;
        entry.acquiredAt = entry.acquiredAt || Date.now();
        cardsMap.set(card.id, entry);
        prog.cards = cardsMap;
        prog.markModified('cards');
        await prog.save();
        await message.channel.send(`Gave card ${card.name} to <@${target.id}>.`);
        break;
      }

      case 'setlevel': {
        if (args.length < 4) {
          await message.channel.send("❌ Usage: !mod setlevel <card_name> @user <level>");
          return;
        }

        const target = message.mentions.users.first();
        if (!target) {
          await message.channel.send("❌ Please mention a user to modify.");
          return;
        }

        const level = parseInt(args[args.length - 1]);
        if (isNaN(level) || level < 0) {
          await message.channel.send("❌ Please provide a valid level (0 or higher).");
          return;
        }

        const cardName = args.slice(1, -2).join(" ");
        const card = fuzzyFindCard(cardName);
        if (!card) {
          await message.channel.send(`❌ Card not found for query: ${cardName}`);
          return;
        }

        let prog = await Progress.findOne({ userId: target.id });
        if (!prog) prog = new Progress({ userId: target.id, cards: {} });
        const cardsMap = prog.cards instanceof Map ? prog.cards : new Map(Object.entries(prog.cards || {}));
        const entry = cardsMap.get(card.id) || { count: 0, xp: 0, level: 0 };
        entry.level = level;
        cardsMap.set(card.id, entry);
        prog.cards = cardsMap;
        prog.markModified('cards');
        await prog.save();
        await message.channel.send(`Set level of ${card.name} for <@${target.id}> to ${level}.`);
        break;
      }

      case 'setbal':
      case 'givebal':
      case 'takebal': {
        if (args.length < 3) {
          await message.channel.send(`❌ Usage: !mod ${subcommand} <amount> @user`);
          return;
        }

        const amount = parseInt(args[1]);
        if (isNaN(amount) || amount < 0) {
          await message.channel.send("❌ Please provide a valid amount (0 or higher).");
          return;
        }

        const target = message.mentions.users.first();
        if (!target) {
          await message.channel.send("❌ Please mention a user to modify.");
          return;
        }

        let bal = await Balance.findOne({ userId: target.id });
        if (!bal) bal = new Balance({ userId: target.id, amount: 500 });

        if (subcommand === "setbal") {
          bal.amount = amount;
        } else if (subcommand === "givebal") {
          bal.amount += amount;
        } else {
          bal.amount = Math.max(0, bal.amount - amount);
        }

        await bal.save();
        await message.channel.send(
          `${subcommand === "setbal" ? "Set" : subcommand === "givebal" ? "Added" : "Removed"} ${amount}¥ ${subcommand === "givebal" ? "to" : subcommand === "takebal" ? "from" : "for"} <@${target.id}>, new balance: ${bal.amount}¥.`
        );
        break;
      }

      default:
        await message.channel.send("❌ Unknown mod command. Use !mod list to see available commands.");
        break;
      }
  }
}