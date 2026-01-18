import "dotenv/config";
import express from "express";
import cors from "cors";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

/**
 * ENV obrigatórias:
 * DISCORD_TOKEN
 * GUILD_ID
 * APPLICATION_CHANNEL_ID
 * STAFF_ROLE_ID
 * TICKETS_CHANNEL_ID
 * API_SECRET  (opcional, mas recomendado)
 *
 * Porta:
 * PORT (Discloud) ou BOT_PORT (local)
 */

function must(name) {
  if (!process.env[name]) throw new Error(`Faltando ${name} no .env/Variables`);
  return process.env[name];
}

const DISCORD_TOKEN = must("DISCORD_TOKEN");
const GUILD_ID = must("GUILD_ID");
const APPLICATION_CHANNEL_ID = must("APPLICATION_CHANNEL_ID");
const STAFF_ROLE_ID = must("STAFF_ROLE_ID");
const TICKETS_CHANNEL_ID = must("TICKETS_CHANNEL_ID");
const API_SECRET = process.env.API_SECRET || ""; // se vazio, não valida secret

const PORT = Number(process.env.PORT || process.env.BOT_PORT || 3001);

// ---------- Discord Client ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel], // pra DM funcionar
});

client.once("ready", () => {
  console.log(`✅ Bot online como ${client.user?.tag}`);
});

// evita crash por erro não tratado
client.on("error", (e) => console.error("Client error:", e));
process.on("unhandledRejection", (e) => console.error("UnhandledRejection:", e));

// ---------- Express API ----------
const app = express();
app.use(express.json({ limit: "128kb" }));

// CORS (liberado por enquanto). Quando você tiver a URL final do seu site, eu travo certinho.
app.use(cors({ origin: "*", methods: ["POST", "OPTIONS"] }));

app.get("/", (req, res) => res.status(200).send("Belmont API OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

function safeTrim(v, max) {
  return String(v ?? "").trim().slice(0, max);
}

function isDiscordId(v) {
  return /^\d{17,20}$/.test(String(v ?? "").trim());
}

function staffHasRole(member) {
  return member?.roles?.cache?.has(STAFF_ROLE_ID);
}

function buildApplicationEmbed(data) {
  const e = new EmbedBuilder()
    .setTitle("📨 Nova Inscrição | Família Belmont")
    .setDescription("Recebida pelo site. Use os botões abaixo para aprovar ou reprovar.")
    .addFields(
      { name: "1) ID Discord", value: `\`${data.discord_id}\``, inline: true },
      { name: "2) RG (in-game)", value: `\`${data.rg}\``, inline: true },
      { name: "3) Nome (in-game)", value: data.nome, inline: false },
      { name: "4) Tempo de Nova Capital", value: data.tempo, inline: false },
      { name: "5) Amor à vida", value: data.amor, inline: false },
      { name: "6) 3 áreas safes", value: data.safes, inline: false },
      { name: "7) Min/Máx bandidos (joalheria)", value: data.joalheria, inline: false },
      { name: "8) Você é bom em:", value: data.skill, inline: true },
      { name: "9) O que pretende fazer (min 5 linhas)", value: data.pretende, inline: false }
    )
    .setFooter({ text: "Sistema de Recrutamento | Família Belmont" })
    .setTimestamp();

  return e;
}

function buildButtons(discordId) {
  // customId leva o id do candidato para localizar depois
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve:${discordId}`)
      .setLabel("Aprovar")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`reject:${discordId}`)
      .setLabel("Reprovar")
      .setStyle(ButtonStyle.Danger)
  );
  return row;
}

function disableButtons(row) {
  // cria cópia desabilitada
  const newRow = new ActionRowBuilder();
  for (const c of row.components) {
    newRow.addComponents(ButtonBuilder.from(c).setDisabled(true));
  }
  return newRow;
}

// ---------- Endpoint que o site chama ----------
app.post("/apply", async (req, res) => {
  try {
    // Secret opcional
    if (API_SECRET) {
      const got = String(req.headers["x-api-secret"] || "");
      if (got !== API_SECRET) return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const body = req.body || {};

    // validações
    const discord_id = safeTrim(body.discord_id, 25);
    const rg = safeTrim(body.rg, 20);
    const nome = safeTrim(body.nome, 80);
    const tempo = safeTrim(body.tempo, 80);
    const amor = safeTrim(body.amor, 900);
    const safes = safeTrim(body.safes, 900);
    const joalheria = safeTrim(body.joalheria, 120);
    const skill = safeTrim(body.skill, 30);
    const pretende = safeTrim(body.pretende, 1400);

    if (!isDiscordId(discord_id)) return res.status(400).json({ ok: false, error: "ID do Discord inválido." });
    if (!rg || !nome || !tempo || !amor || !safes || !joalheria || !skill || !pretende) {
      return res.status(400).json({ ok: false, error: "Campos obrigatórios faltando." });
    }
    if (!(skill === "P1" || skill === "Trocação")) {
      return res.status(400).json({ ok: false, error: "Skill inválida." });
    }

    const data = { discord_id, rg, nome, tempo, amor, safes, joalheria, skill, pretende };

    const channel = await client.channels.fetch(APPLICATION_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return res.status(500).json({ ok: false, error: "Canal de inscrições inválido." });
    }

    const embed = buildApplicationEmbed(data);
    const row = buildButtons(discord_id);

    await channel.send({ embeds: [embed], components: [row] });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("apply error:", err);
    return res.status(500).json({ ok: false, error: "Erro interno." });
  }
});

// ---------- Interações (botões e modal) ----------
client.on("interactionCreate", async (interaction) => {
  try {
    // Botões
    if (interaction.isButton()) {
      const [action, discordId] = interaction.customId.split(":");
      if (!discordId || !isDiscordId(discordId)) {
        return interaction.reply({ content: "❌ Ação inválida.", ephemeral: true }).catch(() => {});
      }

      const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
      if (!guild) return interaction.reply({ content: "❌ Guild inválida.", ephemeral: true }).catch(() => {});

      const member = await guild.members.fetch(interaction.user.id).catch(() => null);
      if (!staffHasRole(member)) {
        return interaction.reply({ content: "❌ Você não tem permissão.", ephemeral: true }).catch(() => {});
      }

      // IMPORTANTÍSSIMO: responder rápido pra não dar "Unknown interaction"
      await interaction.deferReply({ ephemeral: true }).catch(() => {});

      if (action === "approve") {
        // desabilitar botões na mensagem do canal
        const msg = interaction.message;
        const components = msg.components?.map(disableButtons) || [];
        await msg.edit({ components }).catch(() => {});

        // DM pro candidato
        const user = await client.users.fetch(discordId).catch(() => null);
        if (user) {
          await user.send(
            [
              "✅ **Você foi aprovado(a) na Família Belmont!**",
              "",
              "📌 Próximo passo:",
              `➡️ Abra um ticket no canal <#${TICKETS_CHANNEL_ID}> na aba **Recrutamento**.`,
              "",
              "Se suas DMs estavam fechadas, ative para receber avisos.",
            ].join("\n")
          ).catch(() => {});
        }

        return interaction.editReply({ content: "✅ Aprovado com sucesso." }).catch(() => {});
      }

      if (action === "reject") {
        // abrir modal pedindo motivo
        const modal = new ModalBuilder()
          .setCustomId(`rejectModal:${discordId}`)
          .setTitle("Reprovar candidato");

        const motivo = new TextInputBuilder()
          .setCustomId("motivo")
          .setLabel("Motivo da reprovação")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500)
          .setPlaceholder("Explique o motivo (respeitoso e direto).");

        modal.addComponents(new ActionRowBuilder().addComponents(motivo));

        // modal precisa ser showModal, então respondemos DE NOVO via followUp e encerramos defer
        await interaction.deleteReply().catch(() => {}); // remove o "processando" (opcional)
        return interaction.showModal(modal).catch(() => {});
      }

      return interaction.editReply({ content: "❌ Ação desconhecida." }).catch(() => {});
    }

    // Modal de reprovação
    if (interaction.isModalSubmit()) {
      const [kind, discordId] = interaction.customId.split(":");
      if (kind !== "rejectModal" || !isDiscordId(discordId)) {
        return interaction.reply({ content: "❌ Modal inválido.", ephemeral: true }).catch(() => {});
      }

      const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
      const member = guild ? await guild.members.fetch(interaction.user.id).catch(() => null) : null;
      if (!staffHasRole(member)) {
        return interaction.reply({ content: "❌ Você não tem permissão.", ephemeral: true }).catch(() => {});
      }

      await interaction.deferReply({ ephemeral: true }).catch(() => {});

      const motivo = safeTrim(interaction.fields.getTextInputValue("motivo"), 500);

      // desabilitar botões na mensagem original
      const msg = interaction.message;
      const components = msg?.components?.map(disableButtons) || [];
      if (msg) await msg.edit({ components }).catch(() => {});

      // DM candidato
      const user = await client.users.fetch(discordId).catch(() => null);
      if (user) {
        await user.send(
          [
            "❌ **Sua inscrição na Família Belmont foi reprovada.**",
            "",
            `📝 Motivo: ${motivo}`,
            "",
            "✅ Você poderá tentar novamente mais tarde.",
          ].join("\n")
        ).catch(() => {});
      }

      return interaction.editReply({ content: "❌ Reprovado com sucesso." }).catch(() => {});
    }
  } catch (err) {
    console.error("interaction error:", err);
    // nunca deixe crashar
    if (interaction?.isRepliable()) {
      interaction.reply({ content: "❌ Ocorreu um erro.", ephemeral: true }).catch(() => {});
    }
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`🌐 API rodando na porta ${PORT}`);
});

client.login(DISCORD_TOKEN);
