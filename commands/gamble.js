import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import Balance from "../models/Balance.js";
import Inventory from "../models/Inventory.js";

const BJ_SESSIONS = global.__BJ_SESSIONS ||= new Map();

export const data = new SlashCommandBuilder()
  .setName("gamble")
  .setDescription("Gamble an amount")
  .addNumberOption(opt => opt.setName("amount").setDescription("Amount to gamble").setRequired(true));
export const category = "Economy";
export const description = "Gamble money (blackjack or red/black)";

function dayWindow() { return Math.floor(Date.now() / (24*60*60*1000)); }

function makeEmbed(title, desc) {
  return new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0x5865F2);
}

async function getNamiBoost(userId) {
  try {
    const inv = await Inventory.findOne({ userId });
    if (!inv) return { multiplier: 1, percentage: 0 };
    const hasMap = inv.items && typeof inv.items.get === 'function';
    const getCount = (key) => hasMap ? (inv.items.get(key) || 0) : (inv.items && inv.items[key] || 0);
    if (getCount('nami_a_03')) return { multiplier: 1.30, percentage: 30 }; // m3 -> 30%
    if (getCount('nami_b_02')) return { multiplier: 1.20, percentage: 20 }; // m2 -> 20%
    if (getCount('nami_c_01')) return { multiplier: 1.10, percentage: 10 }; // m1 -> 10%
  } catch (e) {
    console.error('Failed to fetch inventory for nami boost:', e);
  }
  return { multiplier: 1, percentage: 0 };
}

function createDeck(decks = 1) {
  const ranks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const deck = [];
  for (let d = 0; d < decks; d++) {
    for (const r of ranks) {
      // four suits
      for (let s = 0; s < 4; s++) deck.push(r);
    }
  }
  // shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardNumericValue(card) {
  if (card === "A") return 11; // flexible in handValue
  if (["J","Q","K"].includes(card)) return 10;
  return parseInt(card, 10) || 0;
}

function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c === "A") { aces++; total += 11; }
    else total += cardNumericValue(c);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

export async function execute(interactionOrMessage) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;

  let amount;
  if (isInteraction) amount = interactionOrMessage.options.getNumber("amount");
  else {
    const parts = interactionOrMessage.content.trim().split(/\s+/);
    amount = parseInt(parts[2], 10) || 0;
  }

  if (!amount || amount <= 0) {
    const reply = "Please specify a valid amount to gamble.";
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  let bal = await Balance.findOne({ userId });
  if (!bal) { bal = new Balance({ userId, amount: 500 }); await bal.save(); }

  // enforce daily limit
  const win = dayWindow();
  if (bal.gambleWindow !== win) {
    bal.gambleWindow = win;
    bal.gamblesToday = 0;
  }
  if ((bal.gamblesToday || 0) >= 10) {
    const reply = "You've reached your 10 gambles for today.";
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  if ((bal.amount || 0) < amount) {
    const reply = "Insufficient balance.";
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  // Get Nami boost info to show in embed
  const boostInfo = await getNamiBoost(userId);
  const boostText = boostInfo.percentage > 0 ? `\n✨ Nami Boost: +${boostInfo.percentage}%` : "";

  // create UI with two buttons (Blackjack / Red or Black)
  const embed = makeEmbed("Gamble", `Choose a game for ${amount}¥:${boostText}`);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gamble:blackjack:${userId}:${amount}`).setLabel("Blackjack").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gamble:redblack:${userId}:${amount}`).setLabel("Red or Black").setStyle(ButtonStyle.Secondary)
  );

  if (isInteraction) {
    const msg = await interactionOrMessage.reply({ embeds: [embed], components: [row], fetchReply: true });
    // attach collector
    const collector = msg.createMessageComponentCollector({ time: 60000 });

    collector.on("collect", async i => {
      if (i.user.id !== userId) return i.reply({ content: "This is not for you.", ephemeral: true });
      const parts = i.customId.split(":");
      const cid0 = parts[0];
      
      // Skip if this is a blackjack action button (handle separately below)
      if (cid0.startsWith("bj_")) return;
      
      const game = parts[1];
      // deduct amount upfront
      bal.amount -= amount;
      bal.gamblesToday = (bal.gamblesToday || 0) + 1;
      await bal.save();

      // Record quest progress for gambling
      try {
        const Quest = (await import("../models/Quest.js")).default;
        const [dailyQuests, weeklyQuests] = await Promise.all([
          Quest.getCurrentQuests("daily"),
          Quest.getCurrentQuests("weekly")
        ]);
        await Promise.all([
          dailyQuests.recordAction(userId, "gamble", 1),
          weeklyQuests.recordAction(userId, "gamble", 1)
        ]);
      } catch (e) {
        console.error("Failed to record gamble quest progress:", e);
      }
      if (game === "redblack") {
        const pick = Math.random() < 0.5 ? "red" : "black";
        // ask user to pick via buttons — create a new message so collectors are scoped
        const pickRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`pick_red:${userId}:${amount}:${pick}`).setLabel("Red").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`pick_black:${userId}:${amount}:${pick}`).setLabel("Black").setStyle(ButtonStyle.Secondary)
        );
        try {
          const pickMsg = await channel.send({ embeds: [makeEmbed("Red or Black", "Pick Red or Black")], components: [pickRow], fetchReply: true });
          const pickCollector = pickMsg.createMessageComponentCollector({ filter: (ii) => ii.user.id === userId && ii.customId.startsWith("pick_"), time: 60000 });
          pickCollector.on("collect", async ii => {
            try { if (!ii.deferred && !ii.replied) await ii.deferUpdate(); } catch (e) { return; }
            const parts = ii.customId.split(":");
            const userIdIn = parts[1];
            const amountIn = parseInt(parts[2],10);
            const correct = parts[3];
            const guess = ii.customId.startsWith("pick_red") ? "red" : "black";
            if (guess === correct) {
              let currentBal = await Balance.findOne({ userId: userIdIn });
              if (!currentBal) currentBal = bal;
              const boostInfo = await getNamiBoost(userIdIn);
              const payout = Math.ceil(amountIn * 2 * boostInfo.multiplier);
              currentBal.amount += payout;
              await currentBal.save();
              try { await ii.editReply({ embeds: [makeEmbed("Red or Black", `It was ${correct}. You win ${payout}¥`)], components: [] }); }
              catch (e) { await ii.followUp({ content: `It was ${correct}. You win ${payout}¥`, ephemeral: false }); }
            } else {
              try { await ii.editReply({ embeds: [makeEmbed("Red or Black", `It was ${correct}. You lose ${amountIn}¥`)], components: [] }); }
              catch (e) { await ii.followUp({ content: `It was ${correct}. You lose ${amountIn}¥`, ephemeral: false }); }
            }
          });
        } catch (e) { try { await i.followUp({ content: "Interaction expired.", ephemeral: true }); } catch {} }
      } else {
        // full blackjack flow: create deck and session with proper card values (A, J, Q, K)
        const decks = 1;
        const deck = createDeck(decks);
        const draw = () => deck.pop();

        // initial deal: player gets one visible total (we won't display individual cards), dealer gets two cards (bot total shown)
        const playerCards = [draw()];
        const dealerCards = [draw(), draw()];

        const buildBJEmbed = (pCards, dCards, message, revealDealer = false) => {
          const pVal = handValue(pCards);
          const dShown = revealDealer ? handValue(dCards) : handValue(dCards); // show dealer total number (per user's requested UI)
          // Show only totals, not the underlying cards
          return makeEmbed("Blackjack", `${message}\nYou: ${pVal} • Dealer: ${dShown}`);
        };

        const actionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`bj_hit:${userId}:${amount}`).setLabel("Hit").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`bj_stand:${userId}:${amount}`).setLabel("Stand").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`bj_double:${userId}:${amount}`).setLabel("Double").setStyle(ButtonStyle.Success)
        );
        const pTotal0 = handValue(playerCards);
        const dTotal0 = handValue(dealerCards);

        // early blackjack check: if player has 21 immediately
        if (pTotal0 === 21 && dTotal0 !== 21) {
          const boostInfo = await getNamiBoost(userId);
          const payout = Math.ceil(amount * 4 * boostInfo.multiplier);
          bal.amount += payout;
          await bal.save();
          try { await i.update({ embeds: [makeEmbed("Blackjack", `You: ${pTotal0} • Dealer: ${dTotal0} \nBlackjack! Bet doubled — you win ${payout}¥`)], components: [] }); }
          catch (e) { await i.followUp({ content: `Blackjack! You win ${payout}¥`, ephemeral: true }); }
          return;
        }

        BJ_SESSIONS.set(userId, { playerCards, dealerCards, bet: amount, doubled: false, deck });
        try { await i.update({ embeds: [buildBJEmbed(playerCards, dealerCards, "Game start")], components: [actionRow] }); }
        catch (e) { await i.followUp({ content: "Interaction expired.", ephemeral: true }); }
      }
    });

    // Handle blackjack action buttons (hit, stand, double)
    const bjCollector = msg.createMessageComponentCollector({ filter: (i) => i.customId.startsWith("bj_"), time: 60000 });
    bjCollector.on("collect", async i => {
      if (i.user.id !== userId) return i.reply({ content: "This is not for you.", ephemeral: true });
      
      const parts = i.customId.split(":");
      const action = parts[0].slice(3); // hit, stand, double
      
      // Refresh balance from database to ensure we have latest amount
      let currentBal = await Balance.findOne({ userId });
      if (!currentBal) currentBal = bal;
      
      const session = BJ_SESSIONS.get(i.user.id);
      if (!session) return i.reply({ content: "No active blackjack session.", ephemeral: true });

      const doDealerPlayAndResolve = async () => {
        while (handValue(session.dealerCards) < 17) session.dealerCards.push(session.deck.pop());
        const pTotal = handValue(session.playerCards);
        const dTotal = handValue(session.dealerCards);
        let result = "lose";
        if (pTotal > 21) result = "lose";
        else if (dTotal > 21 || pTotal > dTotal) result = "win";
        else if (pTotal === dTotal) result = "push";
        else result = "lose";

        if (result === "win") {
          const boostInfo = await getNamiBoost(i.user.id);
          const payout = Math.ceil(session.bet * 2 * boostInfo.multiplier);
          currentBal.amount += payout;
          await currentBal.save();
          try { await i.update({ embeds: [makeEmbed("Blackjack", `You: ${pTotal} • Dealer: ${dTotal} \nYou win ${payout}¥`)], components: [] }); }
          catch (e) { await i.followUp({ content: `You win ${payout}¥`, ephemeral: true }); }
        } else if (result === "push") {
          currentBal.amount += session.bet; await currentBal.save();
          try { await i.update({ embeds: [makeEmbed("Blackjack", `You: ${pTotal} • Dealer: ${dTotal} \nPush — your bet is returned.`)], components: [] }); }
          catch (e) { await i.followUp({ content: `Push — your bet is returned.`, ephemeral: true }); }
        } else {
          try { await i.update({ embeds: [makeEmbed("Blackjack", `You: ${pTotal} • Dealer: ${dTotal} \nYou lose ${session.bet}¥`)], components: [] }); }
          catch (e) { await i.followUp({ content: `You lose ${session.bet}¥`, ephemeral: true }); }
        }
        BJ_SESSIONS.delete(i.user.id);
      };

      if (action === "double") {
        // require exactly two cards to double
        if (session.playerCards.length !== 2) return i.reply({ content: "You can only double on your first move.", ephemeral: true });
        const extra = session.bet;
        if ((currentBal.amount || 0) < extra) return i.reply({ content: "Insufficient balance to double.", ephemeral: true });
        currentBal.amount -= extra;
        session.bet = session.bet * 2;
        session.doubled = true;
        session.playerCards.push(session.deck.pop());

        // after doubling, resolve as stand
        await doDealerPlayAndResolve();
        return;
      }

      if (action === "hit") {
        session.playerCards.push(session.deck.pop());
        const pVal = handValue(session.playerCards);
        if (pVal > 21) {
          BJ_SESSIONS.delete(i.user.id);
          try { await i.update({ embeds: [makeEmbed("Blackjack", `You: ${pVal} • Dealer: ${handValue(session.dealerCards)} \nYou busted and lose ${session.bet}¥`)], components: [] }); }
          catch (e) { await i.followUp({ content: `You busted and lose ${session.bet}¥`, ephemeral: true }); }
          return;
        }

        // if player reaches exactly 21, auto-double the bet (per requirement) and resolve
        if (pVal === 21) {
          session.bet = session.bet * 2;
          await doDealerPlayAndResolve();
          return;
        }

        // otherwise update embed with player's total only
        const buildBJEmbed = (pCards, dCards, message) => {
          const pVal = handValue(pCards);
          const dShown = handValue(dCards);
          return makeEmbed("Blackjack", `${message}\nYou: ${pVal} • Dealer: ${dShown}`);
        };
        
        try { await i.update({ embeds: [buildBJEmbed(session.playerCards, session.dealerCards, "Hit")], components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`bj_hit:${userId}:${session.bet}`).setLabel("Hit").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`bj_stand:${userId}:${session.bet}`).setLabel("Stand").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`bj_double:${userId}:${session.bet}`).setLabel("Double").setStyle(ButtonStyle.Success)
          )
        ] }); }
        catch (e) { await i.followUp({ content: `You: ${handValue(session.playerCards)} • Dealer: ${handValue(session.dealerCards)}`, ephemeral: true }); }
        return;
      }

      if (action === "stand") {
        await doDealerPlayAndResolve();
        return;
      }
    });

    

  } else {
    // prefix: send embed and create collector on channel message
    const msg = await channel.send({ embeds: [embed], components: [row] });
    const collector = msg.createMessageComponentCollector({ time: 60000 });
    collector.on("collect", async i => {
      if (i.user.id !== userId) return i.reply({ content: "This is not for you.", ephemeral: true });
      const parts = i.customId.split(":");
      const cid0 = parts[0];
      
      // Skip if this is a blackjack action button (handle separately below)
      if (cid0.startsWith("bj_")) return;
      
      const game = parts[1];
      // deduct amount upfront
      bal.amount -= amount;
      bal.gamblesToday = (bal.gamblesToday || 0) + 1;
      await bal.save();

      // Record quest progress for gambling
      try {
        const Quest = (await import("../models/Quest.js")).default;
        const [dailyQuests, weeklyQuests] = await Promise.all([
          Quest.getCurrentQuests("daily"),
          Quest.getCurrentQuests("weekly")
        ]);
        await Promise.all([
          dailyQuests.recordAction(userId, "gamble", 1),
          weeklyQuests.recordAction(userId, "gamble", 1)
        ]);
      } catch (e) {
        console.error("Failed to record gamble quest progress:", e);
      }

      if (game === "redblack") {
        const pick = Math.random() < 0.5 ? "red" : "black";
        const pickRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`pick_red:${userId}:${amount}:${pick}`).setLabel("Red").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`pick_black:${userId}:${amount}:${pick}`).setLabel("Black").setStyle(ButtonStyle.Secondary)
        );
        try {
          const pickMsg = await channel.send({ embeds: [makeEmbed("Red or Black", "Pick Red or Black")], components: [pickRow], fetchReply: true });
          const pickCollector = pickMsg.createMessageComponentCollector({ filter: (ii) => ii.user.id === userId && ii.customId.startsWith("pick_"), time: 60000 });
          pickCollector.on("collect", async ii => {
            try { if (!ii.deferred && !ii.replied) await ii.deferUpdate(); } catch (e) { return; }
            const parts = ii.customId.split(":");
            const userIdIn = parts[1];
            const amountIn = parseInt(parts[2],10);
            const correct = parts[3];
            const guess = ii.customId.startsWith("pick_red") ? "red" : "black";
            if (guess === correct) {
              const boostInfo = await getNamiBoost(userIdIn);
              const payout = Math.ceil(amountIn * 2 * boostInfo.multiplier);
              bal.amount += payout;
              await bal.save();
              try { await ii.editReply({ embeds: [makeEmbed("Red or Black", `It was ${correct}. You win ${payout}¥`)], components: [] }); }
              catch (e) { await ii.followUp({ content: `It was ${correct}. You win ${payout}¥`, ephemeral: false }); }
            } else {
              try { await ii.editReply({ embeds: [makeEmbed("Red or Black", `It was ${correct}. You lose ${amountIn}¥`)], components: [] }); }
              catch (e) { await ii.followUp({ content: `It was ${correct}. You lose ${amountIn}¥`, ephemeral: false }); }
            }
          });
        } catch (e) { try { await i.followUp({ content: "Interaction expired.", ephemeral: true }); } catch {} }
      } else if (game === "blackjack") {
        // create interactive blackjack session for prefix users as well (use deck)
        const decks = 1;
        const deck = createDeck(decks);
        const draw = () => deck.pop();

        // initial deal: player gets one card (only total shown), dealer gets two cards
        const playerCards = [draw()];
        const dealerCards = [draw(), draw()];

        const buildBJEmbed = (pCards, dCards, message, revealDealer = false) => {
          const pVal = handValue(pCards);
          const dShown = revealDealer ? handValue(dCards) : handValue(dCards);
          return makeEmbed("Blackjack", `${message}\nYou: ${pVal} • Dealer: ${dShown}`);
        };

        const pTotal0 = handValue(playerCards);
        const dTotal0 = handValue(dealerCards);

        if (pTotal0 === 21 && dTotal0 !== 21) {
          const boostInfo = await getNamiBoost(userId);
          const payout = Math.ceil(amount * 4 * boostInfo.multiplier);
          bal.amount += payout;
          await bal.save();
          try { await i.update({ embeds: [makeEmbed("Blackjack", `You: ${pTotal0} • Dealer: ${dTotal0} \nBlackjack! Bet doubled — you win ${payout}¥`)], components: [] }); } catch(e) { await i.followUp({ content: `Blackjack! You win ${payout}¥`, ephemeral: true }); }
          return;
        }
        const actionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`bj_hit:${userId}:${amount}`).setLabel("Hit").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`bj_stand:${userId}:${amount}`).setLabel("Stand").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`bj_double:${userId}:${amount}`).setLabel("Double").setStyle(ButtonStyle.Success)
        );
        BJ_SESSIONS.set(userId, { playerCards, dealerCards, bet: amount, doubled: false, deck });
        try { await i.update({ embeds: [buildBJEmbed(playerCards, dealerCards, "Game start")], components: [actionRow] }); } catch(e) { await i.followUp({ content: "Interaction expired.", ephemeral: true }); }
      } else {
        // fallback simple result
        const player = Math.floor(Math.random()*11)+1 + Math.floor(Math.random()*11)+1;
        const dealer = Math.floor(Math.random()*11)+1 + Math.floor(Math.random()*11)+1;
        let result = "push";
        if (player > 21) result = "lose";
        else if (dealer > 21 || player > dealer) result = "win";
        else if (player === dealer) result = "push";
        else result = "lose";
        if (result === "win") {
          const boostInfo = await getNamiBoost(i.user.id);
          const payout = Math.ceil(amount * 2 * boostInfo.multiplier);
          bal.amount += payout;
          await bal.save();
          try { await i.update({ embeds: [makeEmbed("Blackjack", `You: ${player} • Dealer: ${dealer} \nYou win ${payout}¥`)], components: [] }); } catch(e) { await i.followUp({ content: `You: ${player} • Dealer: ${dealer} \nYou win ${payout}¥`, ephemeral: true }); }
        } else if (result === "push") {
          bal.amount += amount; await bal.save();
          try { await i.update({ embeds: [makeEmbed("Blackjack", `You: ${player} • Dealer: ${dealer} \nPush — your bet is returned.`)], components: [] }); } catch(e) { await i.followUp({ content: `You: ${player} • Dealer: ${dealer} \nPush — your bet is returned.`, ephemeral: true }); }
        } else {
          try { await i.update({ embeds: [makeEmbed("Blackjack", `You: ${player} • Dealer: ${dealer} \nYou lose ${amount}¥`)], components: [] }); } catch(e) { await i.followUp({ content: `You: ${player} • Dealer: ${dealer} \nYou lose ${amount}¥`, ephemeral: true }); }
        }
      }
    });

    // Handle blackjack action buttons for prefix commands
    const bjCollector = msg.createMessageComponentCollector({ filter: (i) => i.customId.startsWith("bj_"), time: 60000 });
    bjCollector.on("collect", async i => {
      if (i.user.id !== userId) return i.reply({ content: "This is not for you.", ephemeral: true });
      
      const parts = i.customId.split(":");
      const action = parts[0].slice(3); // hit, stand, double
      
      // Refresh balance from database to ensure we have latest amount
      let currentBal = await Balance.findOne({ userId });
      if (!currentBal) currentBal = bal;
      
      const session = BJ_SESSIONS.get(i.user.id);
      if (!session) return i.reply({ content: "No active blackjack session.", ephemeral: true });

      const doDealerPlayAndResolve = async () => {
        while (handValue(session.dealerCards) < 17) session.dealerCards.push(session.deck.pop());
        const pTotal = handValue(session.playerCards);
        const dTotal = handValue(session.dealerCards);
        let result = "lose";
        if (pTotal > 21) result = "lose";
        else if (dTotal > 21 || pTotal > dTotal) result = "win";
        else if (pTotal === dTotal) result = "push";
        else result = "lose";

        if (result === "win") {
          const boostInfo = await getNamiBoost(i.user.id);
          const payout = Math.ceil(session.bet * 2 * boostInfo.multiplier);
          currentBal.amount += payout;
          await currentBal.save();
          try { await i.update({ embeds: [makeEmbed("Blackjack", `You: ${pTotal} • Dealer: ${dTotal} \nYou win ${payout}¥`)], components: [] }); }
          catch (e) { await i.followUp({ content: `You win ${payout}¥`, ephemeral: true }); }
        } else if (result === "push") {
          currentBal.amount += session.bet; await currentBal.save();
          try { await i.update({ embeds: [makeEmbed("Blackjack", `You: ${pTotal} • Dealer: ${dTotal} \nPush — your bet is returned.`)], components: [] }); }
          catch (e) { await i.followUp({ content: `Push — your bet is returned.`, ephemeral: true }); }
        } else {
          try { await i.update({ embeds: [makeEmbed("Blackjack", `You: ${pTotal} • Dealer: ${dTotal} \nYou lose ${session.bet}¥`)], components: [] }); }
          catch (e) { await i.followUp({ content: `You lose ${session.bet}¥`, ephemeral: true }); }
        }
        BJ_SESSIONS.delete(i.user.id);
      };

      if (action === "double") {
        if (session.playerCards.length !== 2) return i.reply({ content: "You can only double on your first move.", ephemeral: true });
        const extra = session.bet;
        if ((currentBal.amount || 0) < extra) return i.reply({ content: "Insufficient balance to double.", ephemeral: true });
        currentBal.amount -= extra;
        session.bet = session.bet * 2;
        session.doubled = true;
        session.playerCards.push(session.deck.pop());
        await currentBal.save();
        await doDealerPlayAndResolve();
        return;
      }

      if (action === "hit") {
        session.playerCards.push(session.deck.pop());
        const pVal = handValue(session.playerCards);
        if (pVal > 21) {
          BJ_SESSIONS.delete(i.user.id);
          try { await i.update({ embeds: [makeEmbed("Blackjack", `You: ${pVal} • Dealer: ${handValue(session.dealerCards)} \nYou busted and lose ${session.bet}¥`)], components: [] }); }
          catch (e) { await i.followUp({ content: `You busted and lose ${session.bet}¥`, ephemeral: true }); }
          return;
        }

        if (pVal === 21) {
          session.bet = session.bet * 2;
          await doDealerPlayAndResolve();
          return;
        }

        const buildBJEmbed = (pCards, dCards, message) => {
          const pVal = handValue(pCards);
          const dShown = handValue(dCards);
          return makeEmbed("Blackjack", `${message}\nYou: ${pVal} • Dealer: ${dShown}`);
        };
        
        try { await i.update({ embeds: [buildBJEmbed(session.playerCards, session.dealerCards, "Hit")], components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`bj_hit:${userId}:${session.bet}`).setLabel("Hit").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`bj_stand:${userId}:${session.bet}`).setLabel("Stand").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`bj_double:${userId}:${session.bet}`).setLabel("Double").setStyle(ButtonStyle.Success)
          )
        ] }); }
        catch (e) { await i.followUp({ content: `You: ${handValue(session.playerCards)} • Dealer: ${handValue(session.dealerCards)}`, ephemeral: true }); }
        return;
      }

      if (action === "stand") {
        await doDealerPlayAndResolve();
        return;
      }
    });

    // Note: red/black picks use per-message collectors created when the pick message is sent.
    // Removed a legacy channel-scoped collector to prevent collector cross-talk.
  }
}
