import { REST, Routes } from "discord.js";
import { commands } from "../commands";

const commandsData = Object.values(commands).map((command) => command.data);

const token: string = process.env.DISCORD_TOKEN || "";
const clientId: string = process.env.DISCORD_CLIENT_ID || "";
const rest = new REST({ version: "10" }).setToken(token);

type DeployCommandsProps = {
  guildId: string;
};

export async function deployCommands({ guildId }: DeployCommandsProps) {
  try {
    console.log("Started refreshing application (/) commands.");

    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commandsData,
    });

    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error(error);
  }
}
