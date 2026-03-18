import React from 'react';
import { createRoot } from 'react-dom/client';
import { settingsManager, WTrackerSettings } from './components/Settings.js';

import { buildPrompt, Message, Generator } from 'sillytavern-utils-lib';
import { ChatMessage, EventNames, ExtractedData } from 'sillytavern-utils-lib/types';
import { characters, name1, selected_group, st_echo } from 'sillytavern-utils-lib/config';
import { AutoModeOptions } from 'sillytavern-utils-lib/types/translate';
import { ExtensionSettings, PromptEngineeringMode, EXTENSION_KEY, extensionName } from './config.js';
import { parseResponse } from './parser.js';
import { schemaToExample } from './schema-to-example.js';
import * as Handlebars from 'handlebars';
import { POPUP_RESULT, POPUP_TYPE } from 'sillytavern-utils-lib/types/popup';

// --- Constants and Globals ---
const CHAT_METADATA_SCHEMA_PRESET_KEY = 'schemaKey';
const CHAT_METADATA_WTRACKER_IGNORE_KEY = 'wtracker_ignore';
const CHAT_MESSAGE_SCHEMA_VALUE_KEY = 'value';
const CHAT_MESSAGE_SCHEMA_HTML_KEY = 'html';

const globalContext = SillyTavern.getContext();
const generator = new Generator();
const pendingRequests = new Map<number, string>();
const incomingTypes = [AutoModeOptions.RESPONSES, AutoModeOptions.BOTH];
const outgoingTypes = [AutoModeOptions.INPUT, AutoModeOptions.BOTH];

// --- Handlebars Helper ---
if (!Handlebars.helpers['join']) {
  Handlebars.registerHelper('join', function (array: any, separator: any) {
    if (Array.isArray(array)) {
      return array.join(typeof separator === 'string' ? separator : ', ');
    }
    return '';
  });
}

// --- Core Logic Functions (ported from original index.ts) ---

function renderTracker(messageId: number) {
  const message = globalContext.chat[messageId];
  const messageBlock = document.querySelector(`.mes[mesid="${messageId}"]`);
  messageBlock?.querySelector('.mes_wtracker')?.remove();

  if (!message?.extra?.[EXTENSION_KEY]) return;

  const trackerData = message.extra[EXTENSION_KEY][CHAT_MESSAGE_SCHEMA_VALUE_KEY];
  const trackerHtmlSchema = message.extra[EXTENSION_KEY][CHAT_MESSAGE_SCHEMA_HTML_KEY];
  if (!trackerData || !trackerHtmlSchema) return;

  if (!messageBlock) return;

  const template = Handlebars.compile(trackerHtmlSchema, { noEscape: true, strict: true });
  const renderedHtml = template({ data: trackerData });
  const container = document.createElement('div');
  container.className = 'mes_wtracker';
  container.innerHTML = renderedHtml;

  // Add controls
  const controls = document.createElement('div');
  controls.className = 'wtracker-controls';
  controls.innerHTML = `
    <div class="wtracker-regenerate-button fa-solid fa-arrows-rotate" title="Regenerate Tracker"></div>
    <div class="wtracker-edit-button fa-solid fa-code" title="Edit Tracker Data"></div>
    <div class="wtracker-delete-button fa-solid fa-trash-can" title="Delete Tracker"></div>
  `;
  container.prepend(controls);

  messageBlock.querySelector('.mes_text')?.before(container);
}

function normalizeAvatarRef(value?: string): string | undefined {
  if (!value || typeof value !== 'string') return undefined;

  let normalized = value.trim();
  if (!normalized) return undefined;

  // Handle thumbnail URLs like /thumbnail?type=avatar&file=char.png
  const queryIndex = normalized.indexOf('?');
  if (queryIndex !== -1) {
    const query = normalized.substring(queryIndex + 1);
    const params = new URLSearchParams(query);
    const fileParam = params.get('file');
    if (fileParam) {
      normalized = fileParam;
    }
  }

  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep original value when decode fails.
  }

  const slashIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (slashIndex !== -1) {
    normalized = normalized.substring(slashIndex + 1);
  }

  return normalized.trim() || undefined;
}

function getIgnoredAvatarSet(): Set<string> {
  const ignoreList: string[] = (SillyTavern.getContext().chatMetadata as any)?.[CHAT_METADATA_WTRACKER_IGNORE_KEY] ?? [];
  return new Set(ignoreList.map((item) => normalizeAvatarRef(item)).filter((item): item is string => !!item));
}

function getGroupMemberAvatar(member: JQuery): string | undefined {
  const charId = member.attr('chid');
  if (charId !== undefined) {
    const char = (characters as any)[charId];
    const avatar = normalizeAvatarRef(char?.avatar);
    if (avatar) return avatar;
  }

  // Fallback for future DOM shape changes.
  const src = member.find('img').first().attr('src');
  return normalizeAvatarRef(src);
}

function ensureWTrackerButtonForMember(member: JQuery): void {
  if (!member.hasClass('group_member')) return;
  if (member.find('.ignore_wtracker_toggle').length > 0) return;

  const icon = member.find('.group_member_icon').first();
  if (!icon.length) return;

  icon.before(
    '<div title="Toggle status tracking" class="ignore_wtracker_toggle fa-solid fa-file-pen right_menu_button fa-lg interactable" tabindex="0"></div>',
  );
}

function includeWTrackerMessages<T extends Message | ChatMessage>(messages: T[], settings: ExtensionSettings): T[] {
  let copyMessages = structuredClone(messages);
  if (settings.includeLastXWTrackerMessages > 0) {
    for (let i = 0; i < settings.includeLastXWTrackerMessages; i++) {
      let foundMessage: T | null = null;
      let foundIndex = -1;
      for (let j = copyMessages.length - 2; j >= 0; j--) {
        // -2 to skip current message
        const message = copyMessages[j];
        const extra = 'source' in message ? (message as Message).source?.extra : (message as ChatMessage).extra;
        // @ts-ignore
        if (!message.wTrackerFound && extra?.[EXTENSION_KEY]?.[CHAT_MESSAGE_SCHEMA_VALUE_KEY]) {
          // @ts-ignore
          message.wTrackerFound = true;
          foundMessage = message;
          foundIndex = j;
          break;
        }
      }
      if (foundMessage) {
        const extra =
          'source' in foundMessage ? (foundMessage as Message).source?.extra : (foundMessage as ChatMessage).extra;
        const content = `Status:\n\`\`\`json\n${JSON.stringify(extra?.[EXTENSION_KEY]?.[CHAT_MESSAGE_SCHEMA_VALUE_KEY] || '{}', null, 2)}\n\`\`\``;
        copyMessages.splice(foundIndex, 0, {
          content,
          role: 'system',
          name: '',
          is_user: false,
          mes: content,
          is_system: true,
        } as unknown as T);
      }
    }
  }
  for (let j = copyMessages.length - 1; j >= 0; j--) {
        // -2 to skip current message
        const message = copyMessages[j];
        const extra = 'source' in message ? (message as Message).source?.extra : (message as ChatMessage).extra;
        if (extra?.reasoning) {
          // @ts-ignore
          extra.reasoning = "";
        }
      } 
  return copyMessages;
}

async function deleteTracker(messageId: number) {
  const message = globalContext.chat[messageId];
  if (!message?.extra?.[EXTENSION_KEY]) return;

  const confirm = await globalContext.Popup.show.confirm(
    'Delete Tracker',
    'Are you sure you want to delete the tracker data for this message? This cannot be undone.',
  );

  if (confirm) {
    delete message.extra[EXTENSION_KEY];
    await globalContext.saveChat();
    renderTracker(messageId); // This will remove the rendered tracker
    st_echo('success', 'Tracker data deleted.');
  }
}

async function editTracker(messageId: number) {
  const message = globalContext.chat[messageId];
  if (!message?.extra?.[EXTENSION_KEY]?.[CHAT_MESSAGE_SCHEMA_VALUE_KEY]) return;

  const currentData = message.extra[EXTENSION_KEY][CHAT_MESSAGE_SCHEMA_VALUE_KEY];

  const popupContent = `
        <div style="display: flex; flex-direction: column; gap: 8px;">
            <label for="wtracker-edit-textarea">Edit Tracker JSON:</label>
            <textarea id="wtracker-edit-textarea" class="text_pole" rows="15" style="width: 100%; resize: vertical;"></textarea>
        </div>
    `;

  globalContext.callGenericPopup(popupContent, POPUP_TYPE.CONFIRM, 'Edit Tracker', {
    okButton: 'Save',
    onClose: async (popup) => {
      if (popup.result === POPUP_RESULT.AFFIRMATIVE) {
        const textarea = popup.content.querySelector('#wtracker-edit-textarea') as HTMLTextAreaElement;
        if (textarea) {
          try {
            const newData = JSON.parse(textarea.value);
            // @ts-ignore
            message.extra[EXTENSION_KEY][CHAT_MESSAGE_SCHEMA_VALUE_KEY] = newData;
            await globalContext.saveChat();
            let detailsState: boolean[] = [];
            const messageBlock = document.querySelector(`.mes[mesid="${messageId}"]`);
            const existingTracker = messageBlock?.querySelector('.mes_wtracker');
            if (existingTracker) {
              const detailsElements = existingTracker.querySelectorAll('details');
              detailsState = Array.from(detailsElements).map((detail) => detail.open);
            }
            renderTracker(messageId);
            if (detailsState.length > 0) {
              const newTracker = messageBlock?.querySelector('.mes_wtracker');
              if (newTracker) {
                const newDetailsElements = newTracker.querySelectorAll('details');
                newDetailsElements.forEach((detail, index) => {
                  // Safety check: only apply if a state for this index exists
                  if (detailsState[index] !== undefined) {
                    detail.open = detailsState[index];
                  }
                });
              }
            }
            st_echo('success', 'Tracker data updated.');
          } catch (e) {
            console.error('Error parsing new tracker data:', e);
            st_echo('error', 'Invalid JSON. Changes were not saved.');
          }
        }
      }
    },
  });
  const textarea = document.querySelector('#wtracker-edit-textarea') as HTMLTextAreaElement;
  if (textarea) {
    textarea.value = JSON.stringify(currentData, null, 2);
  }
}

// --- Group Member WTracker Toggle ---

function updateWTrackerMemberButton(member: JQuery): void {
  const button = member.find('.ignore_wtracker_toggle');
  const charAvatar = getGroupMemberAvatar(member);
  if (!charAvatar) return;

  if (getIgnoredAvatarSet().has(charAvatar)) {
    button.removeClass('active');
  } else {
    button.addClass('active');
  }
}

function updateAllWTrackerMemberButtons(): void {
  $('#rm_group_members .group_member').each((_i, el) => {
    const member = $(el);
    ensureWTrackerButtonForMember(member);
    updateWTrackerMemberButton(member);
  });
}

function toggleWTrackerForMember(e: Event): void {
  const target = $(e.target as HTMLElement).closest('.group_member');
  const charAvatar = getGroupMemberAvatar(target);
  if (!charAvatar) return;

  const context = SillyTavern.getContext();
  const chatMetadata = context.chatMetadata as any;
  if (!chatMetadata[CHAT_METADATA_WTRACKER_IGNORE_KEY]) {
    chatMetadata[CHAT_METADATA_WTRACKER_IGNORE_KEY] = [];
  }
  const normalizedAvatar = normalizeAvatarRef(charAvatar);
  if (!normalizedAvatar) return;

  const rawIgnoreList: string[] = chatMetadata[CHAT_METADATA_WTRACKER_IGNORE_KEY];
  const ignoreSet = new Set(rawIgnoreList.map((a) => normalizeAvatarRef(a)).filter((a): a is string => !!a));

  if (ignoreSet.has(normalizedAvatar)) {
    ignoreSet.delete(normalizedAvatar);
  } else {
    ignoreSet.add(normalizedAvatar);
  }

  chatMetadata[CHAT_METADATA_WTRACKER_IGNORE_KEY] = Array.from(ignoreSet);
  context.saveMetadataDebounced();
  updateWTrackerMemberButton(target);
}

async function generateTracker(id: number) {
  const message = globalContext.chat[id];
  if (!message) return st_echo('error', `Message with ID ${id} not found.`);

  // Skip generation if this character is excluded from WTracking
  const ignoredAvatars = getIgnoredAvatarSet();
  const messageAvatar = normalizeAvatarRef(
    (message as any).original_avatar ?? (message as any).force_avatar ?? (message as any).avatar,
  );
  if (messageAvatar && ignoredAvatars.has(messageAvatar)) return;

  if (pendingRequests.has(id)) {
    const requestId = pendingRequests.get(id)!;
    generator.abortRequest(requestId);
    st_echo('info', 'Tracker generation cancelled.');
    return;
  }

  const settings = settingsManager.getSettings();
  if (!settings.profileId) return st_echo('error', 'Please select a connection profile in settings.');
  const context = SillyTavern.getContext();
  const chatMetadata = context.chatMetadata;
  const { extensionSettings, CONNECT_API_MAP, saveChat } = globalContext;
  // Ensure chat metadata is initialized
  chatMetadata[EXTENSION_KEY] = chatMetadata[EXTENSION_KEY] || {};
  chatMetadata[EXTENSION_KEY][CHAT_METADATA_SCHEMA_PRESET_KEY] =
    chatMetadata[EXTENSION_KEY][CHAT_METADATA_SCHEMA_PRESET_KEY] || settings.schemaPreset;

  const chatJsonValue = settings.schemaPresets[settings.schemaPreset].value;
  const chatHtmlValue = settings.schemaPresets[settings.schemaPreset].html;

  const profile = extensionSettings.connectionManager?.profiles?.find((p) => p.id === settings.profileId);
  const apiMap = profile?.api ? CONNECT_API_MAP[profile.api] : null;
  let characterId = characters.findIndex((char: any) => char.avatar === message.original_avatar);
  characterId = characterId !== -1 ? characterId : undefined;

  const messageBlock = document.querySelector(`.mes[mesid="${id}"]`);
  const mainButton = messageBlock?.querySelector('.mes_wtracker_button');
  const regenerateButton = messageBlock?.querySelector('.wtracker-regenerate-button');

  let detailsState: boolean[] = [];
  const existingTracker = messageBlock?.querySelector('.mes_wtracker');
  if (existingTracker) {
    const detailsElements = existingTracker.querySelectorAll('details');
    detailsState = Array.from(detailsElements).map((detail) => detail.open);
  }
  try {
    mainButton?.classList.add('spinning');
    regenerateButton?.classList.add('spinning');

    const promptResult = await buildPrompt(apiMap?.selected!, {
      targetCharacterId: characterId,
      messageIndexesBetween: {
        end: id,
        start: settings.includeLastXMessages > 0 ? Math.max(0, id - settings.includeLastXMessages) : 0,
      },
      presetName: profile?.preset,
      contextName: profile?.context,
      instructName: profile?.instruct,
      syspromptName: profile?.sysprompt,
      includeNames: !!selected_group,
    });
    let messages = includeWTrackerMessages(promptResult.result, settings);
    let response: ExtractedData['content'];

    const makeRequest = (requestMessages: Message[], overideParams?: any): Promise<ExtractedData | undefined> => {
      return new Promise((resolve, reject) => {
        const abortController = new AbortController();
        generator.generateRequest(
          {
            profileId: settings.profileId,
            prompt: requestMessages,
            maxTokens: settings.maxResponseToken,
            custom: { signal: abortController.signal },
            overridePayload: {
              ...overideParams,
            },
          },
          {
            abortController,
            onStart: (requestId) => {
              pendingRequests.set(id, requestId);
            },
            onFinish: (requestId, data, error) => {
              pendingRequests.delete(id);
              if (error) {
                return reject(error);
              }
              if (!data) {
                // This is how Generator signals cancellation without an error object
                return reject(new DOMException('Request aborted by user', 'AbortError'));
              }
              resolve(data as ExtractedData | undefined);
            },
          },
        );
      });
    };

    if (settings.promptEngineeringMode === PromptEngineeringMode.NATIVE) {
      messages.push({ content: settings.prompt, role: 'user' });
      const result = await makeRequest(messages, {
        json_schema: { name: 'SceneTracker', strict: true, value: chatJsonValue },
      });
      // @ts-ignore
      response = result?.content;
    } else {
      const format = settings.promptEngineeringMode as 'json' | 'xml';
      const promptTemplate = format === 'json' ? settings.promptJson : settings.promptXml;
      const exampleResponse = schemaToExample(chatJsonValue, format);
      const finalPrompt = Handlebars.compile(promptTemplate, { noEscape: true, strict: true })({
        schema: JSON.stringify(chatJsonValue, null, 2),
        example_response: exampleResponse,
      });
      messages.push({ content: finalPrompt, role: 'user' });
      const rest = await makeRequest(messages);
      if (!rest?.content) throw new Error('No response content received.');
      // @ts-ignore
      response = parseResponse(rest.content, format, { schema: chatJsonValue });
    }

    if (!response || Object.keys(response as any).length === 0) throw new Error('Empty response from WTracker.');

    // Tentatively update message and try to render
    message.extra = message.extra || {};
    message.extra[EXTENSION_KEY] = message.extra[EXTENSION_KEY] || {};
    message.extra[EXTENSION_KEY][CHAT_MESSAGE_SCHEMA_VALUE_KEY] = response;
    message.extra[EXTENSION_KEY][CHAT_MESSAGE_SCHEMA_HTML_KEY] = chatHtmlValue;

    try {
      renderTracker(id);

      if (detailsState.length > 0) {
        const newTracker = messageBlock?.querySelector('.mes_wtracker');
        if (newTracker) {
          const newDetailsElements = newTracker.querySelectorAll('details');
          newDetailsElements.forEach((detail, index) => {
            // Safety check: only apply if a state for this index exists
            if (detailsState[index] !== undefined) {
              detail.open = detailsState[index];
            }
          });
        }
      }

      // If render succeeds, save the chat
      await saveChat();
    } catch (renderError) {
      // If render fails, remove the tracker data we just added
      delete message.extra[EXTENSION_KEY];
      // Re-render to clear the failed attempt from the DOM
      renderTracker(id);
      // Let the outer catch block show the error to the user
      throw new Error(`Generated data failed to render with the current template. Not saved.`);
    }
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Error generating tracker:', error);
      st_echo('error', `Tracker generation failed: ${(error as Error).message}`);
    }
  } finally {
    mainButton?.classList.remove('spinning');
    regenerateButton?.classList.remove('spinning');
  }
}

// --- UI Initialization (Non-React parts) ---

async function initializeGlobalUI() {
  // Add toggle button to group member list entries
  const groupMemberTemplateIcons = $('.group_member_icon');
  const ignoreWTrackerButton = $(`<div title="Toggle status tracking" class="ignore_wtracker_toggle fa-solid fa-file-pen right_menu_button fa-lg interactable" tabindex="0"></div>`);
  groupMemberTemplateIcons.before(ignoreWTrackerButton);

  $('#rm_group_members').on('click', '.ignore_wtracker_toggle', toggleWTrackerForMember);

  const groupMemberList = document.getElementById('rm_group_members');
  if (groupMemberList) {
    const observer = new MutationObserver((mutationList) => {
      for (const mutation of mutationList) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach((node) => {
            const element = node as HTMLElement;
            const nodeAsMember = $(element);
            if (nodeAsMember.hasClass('group_member')) {
              ensureWTrackerButtonForMember(nodeAsMember);
              updateWTrackerMemberButton(nodeAsMember);
            }

            $(element)
              .find('.group_member')
              .each((_i, child) => {
                const childMember = $(child);
                ensureWTrackerButtonForMember(childMember);
                updateWTrackerMemberButton(childMember);
              });
          });
        }
      }
    });
    observer.observe(groupMemberList, { childList: true, subtree: true });
  }

  updateAllWTrackerMemberButtons();

  // Add WTracker icon to message buttons
  const wTrackerIcon = document.createElement('div');
  wTrackerIcon.title = 'WTracker';
  wTrackerIcon.className = 'mes_button mes_wtracker_button fa-solid fa-truck-moving interactable';
  wTrackerIcon.tabIndex = 0;
  document.querySelector('#message_template .mes_buttons .extraMesButtons')?.prepend(wTrackerIcon);

  // Add global click listener for various tracker-related buttons on messages
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const messageEl = target.closest('.mes');

    if (!messageEl) return;
    const messageId = Number(messageEl.getAttribute('mesid'));
    if (isNaN(messageId)) return;

    if (target.classList.contains('mes_wtracker_button')) {
      generateTracker(messageId);
    } else if (target.classList.contains('wtracker-edit-button')) {
      editTracker(messageId);
    } else if (target.classList.contains('wtracker-regenerate-button')) {
      generateTracker(messageId);
    } else if (target.classList.contains('wtracker-delete-button')) {
      deleteTracker(messageId);
    }
  });

  const extensionsMenu = document.querySelector('#extensionsMenu');
  const buttonContainer = document.createElement('div');
  buttonContainer.id = 'wtracker_menu_buttons';
  buttonContainer.className = 'extension_container';
  extensionsMenu?.appendChild(buttonContainer);
  const buttonHtml = await globalContext.renderExtensionTemplateAsync(
    `third-party/${extensionName}`,
    'templates/buttons',
  );
  buttonContainer.insertAdjacentHTML('beforeend', buttonHtml);
  extensionsMenu?.querySelector('#wtracker_modify_schema_preset')?.addEventListener('click', async () => {
    await modifyChatMetadata();
  });

  // Set up event listeners for auto-mode and chat changes
  const settings = settingsManager.getSettings();
  globalContext.eventSource.on(
    EventNames.CHARACTER_MESSAGE_RENDERED,
    (messageId: number) => incomingTypes.includes(settings.autoMode) && generateTracker(messageId),
  );
  globalContext.eventSource.on(
    EventNames.USER_MESSAGE_RENDERED,
    (messageId: number) => outgoingTypes.includes(settings.autoMode) && generateTracker(messageId),
  );
  globalContext.eventSource.on(EventNames.CHAT_CHANGED, () => {
    updateAllWTrackerMemberButtons();
    const { saveChat } = globalContext;
    let chatModified = false;
    globalContext.chat.forEach((message, i) => {
      try {
        renderTracker(i);
      } catch (error) {
        console.error(`Error rendering WTracker on message ${i}, removing data:`, error);
        st_echo('error', 'A WTracker template failed to render. Removing tracker from the message.');
        if (message?.extra?.[EXTENSION_KEY]) {
          delete message.extra[EXTENSION_KEY];
          chatModified = true;
        }
      }
    });
    if (chatModified) {
      saveChat();
    }
  });

  // Register the global generation interceptor
  (globalThis as any).wtrackerGenerateInterceptor = (chat: ChatMessage[]) => {
    const newChat = includeWTrackerMessages(chat, settingsManager.getSettings());
    chat.length = 0;
    chat.push(...newChat);
  };
}

async function modifyChatMetadata() {
  const settings = settingsManager.getSettings();
  const context = SillyTavern.getContext();
  const chatMetadata = context.chatMetadata;
  if (!chatMetadata[EXTENSION_KEY]) {
    chatMetadata[EXTENSION_KEY] = {};
  }
  if (!chatMetadata[EXTENSION_KEY][CHAT_METADATA_SCHEMA_PRESET_KEY]) {
    chatMetadata[EXTENSION_KEY][CHAT_METADATA_SCHEMA_PRESET_KEY] = 'default';
    context.saveMetadataDebounced();
  }
  const currentPresetKey = chatMetadata[EXTENSION_KEY][CHAT_METADATA_SCHEMA_PRESET_KEY];

  // Prepare data for the Handlebars template
  const templateData = {
    presets: Object.entries(settings.schemaPresets).map(([key, preset]) => ({
      key: key,
      name: preset.name,
      selected: key === currentPresetKey,
    })),
  };

  // Render the popup content from the template file
  const popupContent = await globalContext.renderExtensionTemplateAsync(
    'third-party/SillyTavern-WTracker',
    'templates/modify_schema_popup',
    templateData,
  );

  await globalContext.callGenericPopup(popupContent, POPUP_TYPE.CONFIRM, '', {
    okButton: 'Save',
    onClose(popup) {
      if (popup.result === POPUP_RESULT.AFFIRMATIVE) {
        const selectElement = document.getElementById('wtracker-chat-schema-select') as HTMLSelectElement;
        if (selectElement) {
          const newPresetKey = selectElement.value;
          if (newPresetKey !== currentPresetKey) {
            chatMetadata[EXTENSION_KEY][CHAT_METADATA_SCHEMA_PRESET_KEY] = newPresetKey;
            context.saveMetadataDebounced();
            st_echo('success', `Chat schema preset updated to "${settings.schemaPresets[newPresetKey].name}".`);
          }
        }
      }
    },
  });
}

// --- Main Application Entry ---

function renderReactSettings() {
  const settingsContainer = document.getElementById('extensions_settings');
  if (!settingsContainer) {
    console.error('WTracker: Extension settings container not found.');
    return;
  }

  let reactRootEl = document.getElementById('wtracker-react-settings-root');
  if (!reactRootEl) {
    reactRootEl = document.createElement('div');
    reactRootEl.id = 'wtracker-react-settings-root';
    settingsContainer.appendChild(reactRootEl);
  }

  const root = createRoot(reactRootEl);
  root.render(
    <React.StrictMode>
      <WTrackerSettings />
    </React.StrictMode>,
  );
}

function main() {
  renderReactSettings();
  initializeGlobalUI();
}

settingsManager
  .initializeSettings()
  .then(main)
  .catch((error) => {
    console.error(error);
    st_echo('error', 'WTracker data migration failed. Check console for details.');
  });
