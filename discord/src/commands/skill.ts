// OpenCode /skill command — run, list, or inspect skills.
// Skills are registered by OpenCode and synced from remote repos.
// Instead of registering one slash command per skill (which can exceed
// Discord's guild command cap of ~100), we expose a single /skill top-level
// command with run / list / info subcommands.

import { ChannelType, MessageFlags, type TextChannel, type ThreadChannel } from 'discord.js'
import type { AutocompleteContext, CommandHandler } from './types.js'
import { getOrCreateRuntime } from '../session-handler/thread-session-runtime.js'
import { sendThreadMessage, SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { getChannelDirectory, getThreadSession } from '../database.js'
import { store } from '../store.js'
import fs from 'node:fs'

const skillLogger = createLogger(LogPrefix.USER_CMD)

export const handleSkillCommand: CommandHandler = async ({ command, appId }) => {
  const sub = command.options.getSubcommand()

  if (sub === 'list') {
    const skills = store
      .getState()
      .registeredUserCommands.filter((c) => c.source === 'skill')
    if (skills.length === 0) {
      await command.reply({
        content: 'No skills are currently available.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }
    const lines = skills.map((s) => `**${s.name}** — ${s.description}`).join('\n')
    await command.reply({
      content: lines.slice(0, 2000),
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (sub === 'info') {
    const skillName = command.options.getString('name', true)
    const skill = store
      .getState()
      .registeredUserCommands.find((c) => c.name === skillName && c.source === 'skill')
    if (!skill) {
      await command.reply({
        content: `Skill \`${skillName}\` not found. Use \`/skill list\` to see available skills.`,
        flags: MessageFlags.Ephemeral,
      })
      return
    }
    await command.reply({
      content: `**${skill.name}**\n${skill.description}`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  // sub === 'run'
  const skillName = command.options.getString('name', true)
  const args = command.options.getString('arguments') || ''

  const skill = store
    .getState()
    .registeredUserCommands.find((c) => c.name === skillName && c.source === 'skill')
  if (!skill) {
    await command.reply({
      content: `Skill \`${skillName}\` not found. Use \`/skill list\` to see available skills.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const commandName = skill.name
  skillLogger.log(`Executing skill /${commandName} argsLength=${args.length}`)

  const channel = command.channel
  const isThread =
    channel &&
    [
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread,
    ].includes(channel.type)
  const isTextChannel = channel?.type === ChannelType.GuildText

  if (!channel || (!isTextChannel && !isThread)) {
    await command.reply({
      content: 'This command can only be used in text channels or threads',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  let projectDirectory: string | undefined
  let textChannel: TextChannel | null = null
  let thread: ThreadChannel | null = null

  if (isThread) {
    thread = channel as ThreadChannel
    textChannel = thread.parent as TextChannel | null

    const sessionId = await getThreadSession(thread.id)
    if (!sessionId) {
      await command.reply({
        content:
          'This thread does not have an active session. Use this command in a project channel to create a new thread.',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    if (textChannel) {
      const channelConfig = await getChannelDirectory(textChannel.id)
      projectDirectory = channelConfig?.directory
    }
  } else {
    textChannel = channel as TextChannel
    const channelConfig = await getChannelDirectory(textChannel.id)
    projectDirectory = channelConfig?.directory
  }

  if (!projectDirectory) {
    await command.reply({
      content: 'This channel is not configured with a project directory',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (!fs.existsSync(projectDirectory)) {
    await command.reply({
      content: `Directory does not exist: ${projectDirectory}`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await command.deferReply()

  try {
    const commandPayload = { name: commandName, arguments: args }

    if (isThread && thread) {
      await command.editReply(`Running /${commandName}...`)

      const runtime = getOrCreateRuntime({
        threadId: thread.id,
        thread,
        projectDirectory,
        sdkDirectory: projectDirectory,
        channelId: textChannel?.id,
        appId,
      })
      await runtime.enqueueIncoming({
        prompt: '',
        userId: command.user.id,
        username: command.user.displayName,
        command: commandPayload,
        appId,
        mode: 'local-queue',
      })
    } else if (textChannel) {
      const starterMessage = await textChannel.send({
        content: `**/${commandName}**`,
        flags: SILENT_MESSAGE_FLAGS,
      })

      const threadName = `/${commandName}`
      const newThread = await starterMessage.startThread({
        name: threadName.slice(0, 100),
        autoArchiveDuration: 1440,
        reason: `OpenCode skill: ${commandName}`,
      })

      await newThread.members.add(command.user.id)

      if (args) {
        const argsPreview =
          args.length > 1800 ? `${args.slice(0, 1800)}\n... truncated` : args
        await sendThreadMessage(newThread, `Args: ${argsPreview}`)
      }

      await command.editReply(`Started /${commandName} in ${newThread.toString()}`)

      const runtime = getOrCreateRuntime({
        threadId: newThread.id,
        thread: newThread,
        projectDirectory,
        sdkDirectory: projectDirectory,
        channelId: textChannel.id,
        appId,
      })
      await runtime.enqueueIncoming({
        prompt: '',
        userId: command.user.id,
        username: command.user.displayName,
        command: commandPayload,
        appId,
        mode: 'local-queue',
      })
    }
  } catch (error) {
    skillLogger.error(`Error executing skill /${commandName}:`, error)

    const errorMessage = error instanceof Error ? error.message : String(error)

    if (command.deferred) {
      await command.editReply({
        content: `Failed to execute /${commandName}: ${errorMessage}`,
      })
    } else {
      await command.reply({
        content: `Failed to execute /${commandName}: ${errorMessage}`,
        flags: MessageFlags.Ephemeral,
      })
    }
  }
}

export async function handleSkillAutocomplete({
  interaction,
}: AutocompleteContext): Promise<void> {
  const focused = interaction.options.getFocused(true)

  if (focused.name !== 'name') {
    await interaction.respond([])
    return
  }

  const query = focused.value.toLowerCase()
  const choices = store
    .getState()
    .registeredUserCommands.filter(
      (c) => c.source === 'skill' && c.name.toLowerCase().includes(query),
    )
    .slice(0, 25)
    .map((c) => ({
      name: `${c.name} — ${c.description}`.slice(0, 100),
      value: c.name,
    }))

  await interaction.respond(choices)
}
