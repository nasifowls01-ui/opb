import { SlashCommandBuilder } from 'discord.js';
import Progress from '../models/Progress.js';
import Inventory from '../models/Inventory.js';
import { fuzzyFindCard } from '../lib/cardEmbed.js';

export default {
  data: new SlashCommandBuilder()
    .setName('level')
    .setDescription('Use XP books/scrolls to level up a card')
    .addStringOption(option =>
      option.setName('item')
        .setDescription('Item to use: book (100xp) or scroll (10xp)')
        .setRequired(true)
        .addChoices(
          { name: 'book', value: 'book' },
          { name: 'scroll', value: 'scroll' }
        ))
    .addStringOption(option =>
      option.setName('card')
        .setDescription('The card to level up')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Number of items to use')
        .setRequired(true)
        .setMinValue(1)),

  async execute(interactionOrMessage) {
    const isInteraction = typeof interactionOrMessage.isCommand === 'function' || typeof interactionOrMessage.isChatInputCommand === 'function';
    const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;

    let cardName;
    let item;
    let amount;
    if (isInteraction) {
      item = interactionOrMessage.options.getString('item');
      cardName = interactionOrMessage.options.getString('card');
      amount = interactionOrMessage.options.getInteger('amount');
    } else {
      const parts = interactionOrMessage.content.trim().split(/\s+/);
      // Determine where the args start. Support both "level nami" and "op level nami" formats.
      let args;
      if (parts[0] && parts[0].toLowerCase() === 'level') args = parts.slice(1);
      else if (parts[1] && parts[1].toLowerCase() === 'level') args = parts.slice(2);
      else args = parts.slice(1);

      // If first token is item type, use it
      if (args.length > 0 && ['book', 'scroll'].includes(args[0].toLowerCase())) {
        item = args[0].toLowerCase();
        if (args.length === 1) {
          cardName = '';
          amount = undefined;
        } else {
          const lastNum = parseInt(args[args.length - 1], 10);
          if (!isNaN(lastNum)) {
            amount = lastNum;
            cardName = args.slice(1, args.length - 1).join(' ');
          } else {
            amount = undefined;
            cardName = args.slice(1).join(' ');
          }
        }
      } else {
        // no explicit item type: default to scrolls (10xp)
        item = 'scroll';
        if (args.length === 0) {
          cardName = '';
          amount = undefined;
        } else {
          const lastNum = parseInt(args[args.length - 1], 10);
          if (!isNaN(lastNum)) {
            amount = lastNum;
            cardName = args.slice(0, args.length - 1).join(' ');
          } else {
            amount = undefined;
            cardName = args.join(' ');
          }
        }
      }
    }

    const card = fuzzyFindCard(cardName);

    if (!card) {
      const replyContent = `Card not found for query: ${cardName}`;
      if (isInteraction) await interactionOrMessage.reply({ content: replyContent, flags: 64 });
      else await interactionOrMessage.channel.send(replyContent);
      return;
    }

    // If amount wasn't provided in a prefix message, ask user to specify how many to use
    if (!isInteraction && (amount === undefined || amount === null)) {
      const ask = `How many ${item === 'book' ? 'books' : 'scrolls'} would you like to use for ${card.name}? Example: op level ${item} ${card.name} 3`;
      await interactionOrMessage.channel.send(ask);
      return;
    }

    let inventory = await Inventory.findOne({ userId: user.id });
    if (!inventory) {
      inventory = new Inventory({ userId: user.id });
    }

    let progress = await Progress.findOne({ userId: user.id });
    if (!progress) {
      progress = new Progress({ userId: user.id });
    }

    // Ensure cards is a Map
    if (!(progress.cards instanceof Map)) {
      progress.cards = new Map(Object.entries(progress.cards || {}));
    }

    const entry = progress.cards.get(card.id) || { count: 0, xp: 0, level: 0 };

    if (!entry.count) {
      const r = `You don't own this card!`;
      if (isInteraction) await interactionOrMessage.reply({ content: r, flags: 64 });
      else await interactionOrMessage.channel.send(r);
      return;
    }
    // This ensures we don't lose existing level when adding xp
    if (entry.level && (!entry.xp || entry.xp === 0)) {
      entry.xp = entry.level * 100;
    }


    // helper to read items map safely
    const getItemFromMap = (inv, key) => {
      if (!inv || !inv.items) return 0;
      if (typeof inv.items.get === 'function') return inv.items.get(key) || 0;
      return inv.items[key] || 0;
    };

    // ensure user has enough items (books or scrolls)
    if (item === 'book') {
      const haveField = (inventory.xpBooks || 0);
      const haveMap = getItemFromMap(inventory, 'xp_book');
      const have = haveField > 0 ? haveField : haveMap;
      if ((amount || 0) > have) {
        const r = `You don't have enough XP books. You have: ${have}`;
        if (isInteraction) await interactionOrMessage.reply({ content: r, flags: 64 });
        else await interactionOrMessage.channel.send(r);
        return;
      }
    } else {
      // scrolls: prefer xpScrolls field, then xpBottles, then items map 'xp_scroll' or 'xp_bottle'
      const haveField = (inventory.xpScrolls || 0) || (inventory.xpBottles || 0);
      const haveMap = getItemFromMap(inventory, 'xp_scroll') || getItemFromMap(inventory, 'xp_bottle');
      const have = haveField > 0 ? haveField : haveMap;
      if ((amount || 0) > have) {
        const r = `You don't have enough XP scrolls. You have: ${have}`;
        if (isInteraction) await interactionOrMessage.reply({ content: r, flags: 64 });
        else await interactionOrMessage.channel.send(r);
        return;
      }
    }

    // compute XP to add based on item type
    const perItemXP = item === 'book' ? 100 : 10;
    const xpToAdd = (amount || 0) * perItemXP;

    // If target is a weapon, handle weapon leveling via WeaponInventory
    if (card && card.type && String(card.type).toLowerCase() === 'weapon') {
      const WeaponInventory = (await import('../models/WeaponInventory.js')).default;
      let winv = await WeaponInventory.findOne({ userId: user.id });
      if (!winv) winv = new WeaponInventory({ userId: user.id });

      const userWeapon = winv.weapons instanceof Map ? winv.weapons.get(card.id) : (winv.weapons?.[card.id] || null);
      if (!userWeapon) {
        const r = `You don't own that weapon.`;
        if (isInteraction) await interactionOrMessage.reply({ content: r, flags: 64 });
        else await interactionOrMessage.channel.send(r);
        return;
      }

      // add xp and compute weapon level (weapons: 100 xp per level, start at level 1)
      const totalXp = (userWeapon.xp || 0) + xpToAdd;
      const newLevel = 1 + Math.floor(totalXp / 100);
      const remaining = totalXp % 100;
      userWeapon.level = newLevel;
      userWeapon.xp = remaining;

      // persist
      if (winv.weapons instanceof Map) winv.weapons.set(card.id, userWeapon);
      else { winv.weapons = winv.weapons || {}; winv.weapons[card.id] = userWeapon; }
      winv.markModified('weapons');
      await winv.save();

      // consume inventory items
      const decItemInMap = (inv, key, qty) => {
        if (!inv || !inv.items) return 0;
        if (typeof inv.items.get === 'function') {
          const have = inv.items.get(key) || 0;
          const left = Math.max(0, have - qty);
          inv.items.set(key, left);
          return left;
        } else {
          const have = inv.items[key] || 0;
          const left = Math.max(0, have - qty);
          inv.items[key] = left;
          return left;
        }
      };

      if (item === 'book') {
        if ((inventory.xpBooks || 0) > 0) {
          inventory.xpBooks = Math.max(0, (inventory.xpBooks || 0) - amount);
        } else {
          decItemInMap(inventory, 'xp_book', amount);
        }
      } else {
        if ((inventory.xpScrolls || 0) > 0) {
          inventory.xpScrolls = Math.max(0, (inventory.xpScrolls || 0) - amount);
        } else if ((inventory.xpBottles || 0) > 0) {
          inventory.xpBottles = Math.max(0, (inventory.xpBottles || 0) - amount);
        } else {
          decItemInMap(inventory, 'xp_scroll', amount);
          decItemInMap(inventory, 'xp_bottle', amount);
        }
      }
      inventory.markModified('items');
      inventory.markModified('xpBooks');
      inventory.markModified('xpScrolls');
      inventory.markModified('xpBottles');
      await inventory.save();

      const remainingBooks = (inventory.xpBooks || 0) > 0 ? inventory.xpBooks : (typeof inventory.items !== 'undefined' ? (typeof inventory.items.get === 'function' ? (inventory.items.get('xp_book') || 0) : (inventory.items['xp_book'] || 0)) : 0);
      let remainingScrolls = 0;
      if ((inventory.xpScrolls || 0) > 0) remainingScrolls = inventory.xpScrolls;
      else if ((inventory.xpBottles || 0) > 0) remainingScrolls = inventory.xpBottles;
      else if (typeof inventory.items !== 'undefined') {
        if (typeof inventory.items.get === 'function') remainingScrolls = inventory.items.get('xp_scroll') || inventory.items.get('xp_bottle') || 0;
        else remainingScrolls = inventory.items['xp_scroll'] || inventory.items['xp_bottle'] || 0;
      }
      const remainingText = item === 'book' ? `Remaining XP Books: ${remainingBooks || 0}` : `Remaining XP Scrolls: ${remainingScrolls || 0}`;

      const finalMsg = `Added ${xpToAdd} XP to ${card.name}\n` +
        `Current XP: ${userWeapon.xp}\n` +
        `Current Level: ${userWeapon.level}\n` +
        `${remainingText}`;
      if (isInteraction) await interactionOrMessage.reply({ content: finalMsg });
      else await interactionOrMessage.channel.send(finalMsg);
      return;
    }

    // Calculate new level: each level requires (level+1)*100 XP total
    // E.g., Level 0->1 requires 100 XP (1*100), Level 1->2 requires 200 XP (2*100), etc.
    let computedLevel = 0;
    let remainingXp = entry.xp;
    while (remainingXp >= (computedLevel + 1) * 100) {
      remainingXp -= (computedLevel + 1) * 100;
      computedLevel++;
    }
    entry.xp = remainingXp;
    const prevLevel = entry.level || 0;
    entry.level = Math.max(prevLevel, computedLevel);

    // Update the Map and mark as modified
    progress.cards.set(card.id, entry);
    progress.markModified('cards');
    await progress.save();

    // consume inventory: handle both field and items map keys
    const decItemInMap = (inv, key, qty) => {
      if (!inv || !inv.items) return 0;
      if (typeof inv.items.get === 'function') {
        const have = inv.items.get(key) || 0;
        const left = Math.max(0, have - qty);
        inv.items.set(key, left);
        return left;
      } else {
        const have = inv.items[key] || 0;
        const left = Math.max(0, have - qty);
        inv.items[key] = left;
        return left;
      }
    };

    if (item === 'book') {
      if ((inventory.xpBooks || 0) > 0) {
        inventory.xpBooks = Math.max(0, (inventory.xpBooks || 0) - amount);
      } else {
        decItemInMap(inventory, 'xp_book', amount);
      }
    } else {
      if ((inventory.xpScrolls || 0) > 0) {
        inventory.xpScrolls = Math.max(0, (inventory.xpScrolls || 0) - amount);
      } else if ((inventory.xpBottles || 0) > 0) {
        inventory.xpBottles = Math.max(0, (inventory.xpBottles || 0) - amount);
      } else {
        // try map keys
        decItemInMap(inventory, 'xp_scroll', amount);
        decItemInMap(inventory, 'xp_bottle', amount);
      }
    }
    inventory.markModified('items');
    inventory.markModified('xpBooks');
    inventory.markModified('xpScrolls');
    inventory.markModified('xpBottles');
    await inventory.save();

    const remainingBooks = (inventory.xpBooks || 0) > 0 ? inventory.xpBooks : (typeof inventory.items !== 'undefined' ? (typeof inventory.items.get === 'function' ? (inventory.items.get('xp_book') || 0) : (inventory.items['xp_book'] || 0)) : 0);
    let remainingScrolls = 0;
    if ((inventory.xpScrolls || 0) > 0) remainingScrolls = inventory.xpScrolls;
    else if ((inventory.xpBottles || 0) > 0) remainingScrolls = inventory.xpBottles;
    else if (typeof inventory.items !== 'undefined') {
      if (typeof inventory.items.get === 'function') remainingScrolls = inventory.items.get('xp_scroll') || inventory.items.get('xp_bottle') || 0;
      else remainingScrolls = inventory.items['xp_scroll'] || inventory.items['xp_bottle'] || 0;
    }
    const remainingText = item === 'book' ? `Remaining XP Books: ${remainingBooks || 0}` : `Remaining XP Scrolls: ${remainingScrolls || 0}`;

    const finalMsg = `Added ${xpToAdd} XP to ${card.name}\n` +
      `Current XP: ${entry.xp}\n` +
      `Current Level: ${entry.level}\n` +
      `${remainingText}`;
    if (isInteraction) await interactionOrMessage.reply({ content: finalMsg });
    else await interactionOrMessage.channel.send(finalMsg);
  }
};