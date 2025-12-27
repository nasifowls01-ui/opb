import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import Quest from "../models/Quest.js";
import { generateQuests } from "../lib/quests.js";

export const data = new SlashCommandBuilder()
  .setName("quests")
  .setDescription("View your daily and weekly quests");

export const aliases = ["quest"];

export async function buildQuestEmbed(questDoc, user) {
  const embed = new EmbedBuilder()
    .setTitle(`${questDoc.type === "daily" ? "Daily" : "Weekly"} Quests`)
    .setColor(0xFFFFFF)
    .setThumbnail(user.displayAvatarURL());

  const userProgress = questDoc.getUserProgress(user.id);
  const now = new Date();
  const timeLeft = questDoc.expiresAt.getTime() - now.getTime();
  const hours = Math.floor(timeLeft / (1000 * 60 * 60));
  const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));

  let description = `Resets in: ${hours}h ${minutes}m\n\n`;

  // Only show quests that are not claimed for this user
  questDoc.quests.forEach((quest, index) => {
    const progress = userProgress.get(quest.id) || { current: 0, claimed: false };
    if (progress.claimed) return; // don't show claimed quests so UI stays clean per-user

    const status = progress.current >= quest.target ? "✓" : "↺";
    
    // Format rewards
    const rewards = [];
    if (quest.reward.moneyRange[0] === quest.reward.moneyRange[1]) {
      rewards.push(`${quest.reward.moneyRange[0]}¥`);
    } else {
      rewards.push(`${quest.reward.moneyRange[0]}-${quest.reward.moneyRange[1]}¥`);
    }
    
    Object.entries(quest.reward.chests).forEach(([rank, count]) => {
      if (count > 0) rewards.push(`${count}× ${rank} Chest`);
    });

    description += `${status} **${quest.description}**\n`;
    description += `Progress: ${progress.current}/${quest.target}\n`;
    description += `Rewards: ${rewards.join(", ")}\n\n`;
  });

  if (description.trim().endsWith("Quests") || description.trim() === `Resets in: ${hours}h ${minutes}m`) {
    description += `(No active quests for you right now)`;
  }

  embed.setDescription(description);
  return embed;
}

export async function execute(interactionOrMessage, client) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;

  // Get or generate daily quests
  let dailyQuests = await Quest.getCurrentQuests("daily");
  if (!dailyQuests.quests.length) {
    dailyQuests.quests = generateQuests("daily");
    await dailyQuests.save();
  }

  // Build embed and buttons
  const embed = await buildQuestEmbed(dailyQuests, user);
  
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`quest_view:daily:${user.id}`)
        .setLabel("Daily")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`quest_view:weekly:${user.id}`)
        .setLabel("Weekly")
        .setStyle(ButtonStyle.Secondary)
    );

  const claimRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`quest_claim:${user.id}`)
        .setLabel("Claim Completed")
        .setStyle(ButtonStyle.Success)
    );

  if (isInteraction) {
    await interactionOrMessage.reply({ 
      embeds: [embed], 
      components: [row, claimRow] 
    });
  } else {
    await channel.send({ 
      embeds: [embed], 
      components: [row, claimRow] 
    });
  }
}