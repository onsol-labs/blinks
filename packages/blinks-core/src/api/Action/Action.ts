import type { MessageNextActionPostRequest } from '@solana/actions-spec';
import { nanoid } from 'nanoid/non-secure';
import { proxify, proxifyImage } from '../../utils';
import { isUrlSameOrigin } from '../../utils/security.ts';
import type { ActionAdapter } from '../ActionConfig.ts';
import type {
  ActionParameterType,
  ExtendedActionGetResponse,
  LinkedActionType,
  NextAction,
  NextActionLink,
  NextActionPostRequest,
  PostNextActionLink,
  TypedActionParameter,
} from '../actions-spec.ts';
import {
  type AbstractActionComponent,
  ButtonActionComponent,
  FormActionComponent,
  MultiValueActionComponent,
  SingleValueActionComponent,
} from './action-components';
import {
  type ActionSupportStrategy,
  BASELINE_ACTION_BLOCKCHAIN_IDS,
  BASELINE_ACTION_VERSION,
  defaultActionSupportStrategy,
} from './action-supportability.ts';

const MULTI_VALUE_TYPES: ActionParameterType[] = ['checkbox'];

const EXPERIMENTAL_LIVE_DATA_DEFAULT_DELAY_MS = 1000;

interface ActionMetadata {
  blockchainIds?: string[];
  version?: string;
}

type ActionChainMetadata =
  | {
      isChained: true;
      isInline: boolean;
    }
  | {
      isChained: false;
    };

interface LiveData {
  enabled: boolean;
  delayMs?: number;
}

interface ExperimentalFeatures {
  liveData?: LiveData;
}

export class Action {
  private readonly _actions: AbstractActionComponent[];

  private constructor(
    private readonly _url: string,
    private readonly _data: NextAction,
    private readonly _metadata: ActionMetadata,
    private readonly _supportStrategy: ActionSupportStrategy,
    private readonly _chainMetadata: ActionChainMetadata = { isChained: false },
    private readonly _id?: string,
    private readonly _experimental?: ExperimentalFeatures,
  ) {
    // if no links present or completed, fallback to original solana pay spec (or just using the button as a placeholder)
    if (_data.type === 'completed' || !_data.links?.actions) {
      this._actions = [
        new ButtonActionComponent(this, _data.label, _url, 'transaction'),
      ];
      return;
    }

    const urlObj = new URL(_url);
    this._actions = _data.links.actions.map((action) => {
      const href = action.href.startsWith('http')
        ? action.href
        : urlObj.origin + action.href;

      return componentFactory(
        this,
        action.label,
        href,
        action.type ?? 'transaction',
        action.parameters,
      );
    });
  }

  // this API MAY change in the future
  public get liveData_experimental(): Required<LiveData> | null {
    const liveData = this._experimental?.liveData;

    if (!liveData) {
      return null;
    }

    return {
      enabled: liveData.enabled,
      delayMs: liveData.delayMs
        ? Math.max(liveData.delayMs, EXPERIMENTAL_LIVE_DATA_DEFAULT_DELAY_MS)
        : EXPERIMENTAL_LIVE_DATA_DEFAULT_DELAY_MS,
    };
  }

  public get id() {
    return this._id;
  }

  public get isChained() {
    return this._chainMetadata.isChained;
  }

  public get isInline() {
    return this._chainMetadata.isChained ? this._chainMetadata.isInline : false;
  }

  public get type() {
    return this._data.type;
  }

  public get url() {
    return this._url;
  }

  public get icon() {
    if (this._data.icon.startsWith('data:')) {
      return this._data.icon;
    }
    return proxifyImage(this._data.icon).url.toString();
  }

  public get title() {
    return this._data.title;
  }

  public get description() {
    return this._data.description;
  }

  public get disabled() {
    return this._data.disabled ?? false;
  }

  public get actions() {
    return this._actions;
  }

  public get error() {
    return this._data.error?.message ?? null;
  }

  public get metadata(): ActionMetadata {
    // TODO: Remove fallback to baseline version after a few weeks after compatibility is adopted
    return {
      blockchainIds:
        this._metadata.blockchainIds ?? BASELINE_ACTION_BLOCKCHAIN_IDS,
      version: this._metadata.version ?? BASELINE_ACTION_VERSION,
    };
  }

  public async isSupported(adapter: ActionAdapter) {
    try {
      return await this._supportStrategy(this, adapter);
    } catch (e) {
      console.error(
        `[@dialectlabs/blinks] Failed to check supportability for action ${this.url}`,
        e,
      );
      return {
        isSupported: false,
        message:
          'Failed to check supportability, please contact your Blink client provider.',
      };
    }
  }

  public async chain<N extends NextActionLink>(
    next: N,
    chainData?: N extends PostNextActionLink
      ? MessageNextActionPostRequest | NextActionPostRequest
      : never,
  ): Promise<Action | null> {
    const id = nanoid();

    if (next.type === 'inline') {
      return new Action(
        this.url,
        next.action,
        this.metadata,
        this._supportStrategy,
        {
          isChained: true,
          isInline: true,
        },
        id,
      );
    }

    const baseUrlObj = new URL(this.url);

    if (!isUrlSameOrigin(baseUrlObj.origin, next.href)) {
      console.error(
        `Chained action is not the same origin as the current action. Original: ${this.url}, chained: ${next.href}`,
      );
      return null;
    }

    const href = next.href.startsWith('http')
      ? next.href
      : baseUrlObj.origin + next.href;

    const { url: proxyUrl, headers: proxyHeaders } = proxify(href);
    const response = await fetch(proxyUrl, {
      method: 'POST',
      body: JSON.stringify(chainData),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...proxyHeaders,
      },
    });

    if (!response.ok) {
      console.error(
        `Failed to fetch chained action ${proxyUrl}, action url: ${next.href}`,
      );
      return null;
    }

    const data = (await response.json()) as NextAction;
    const metadata = getActionMetadata(response);

    return new Action(
      href,
      data,
      metadata,
      this._supportStrategy,
      {
        isChained: true,
        isInline: false,
      },
      id,
    );
  }

  // be sure to use this only if the action is valid
  static hydrate(
    url: string,
    data: NextAction,
    metadata: ActionMetadata,
    supportStrategy: ActionSupportStrategy,
  ) {
    const id = nanoid();
    return new Action(
      url,
      data,
      metadata,
      supportStrategy,
      { isChained: false },
      id,
    );
  }

  private static async _fetch(
    apiUrl: string,
    supportStrategy: ActionSupportStrategy = defaultActionSupportStrategy,
    chainMetadata?: ActionChainMetadata,
    id?: string,
  ) {
    const { url: proxyUrl, headers: proxyHeaders } = proxify(apiUrl);
    const response = await fetch(proxyUrl, {
      headers: {
        Accept: 'application/json',
        ...proxyHeaders,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch action ${proxyUrl}, action url: ${apiUrl}`,
      );
    }

    const data = (await response.json()) as ExtendedActionGetResponse;
    const metadata = getActionMetadata(response);

    return new Action(
      apiUrl,
      { ...data, type: 'action' },
      metadata,
      supportStrategy,
      chainMetadata,
      id,
      data.dialectExperimental,
    );
  }

  static async fetch(
    apiUrl: string,
    supportStrategy: ActionSupportStrategy = defaultActionSupportStrategy,
  ) {
    const id = nanoid();
    return Action._fetch(
      apiUrl,
      supportStrategy,
      {
        isChained: false,
      },
      id,
    );
  }

  refresh() {
    return Action._fetch(
      this.url,
      this._supportStrategy,
      this._chainMetadata,
      this._id,
    );
  }

  withUpdate(update: { supportStrategy?: ActionSupportStrategy }) {
    return new Action(
      this._url,
      this._data,
      this._metadata,
      update.supportStrategy ?? this._supportStrategy,
      this._chainMetadata,
      this._id,
      this._experimental,
    );
  }
}

const getActionMetadata = (response: Response): ActionMetadata => {
  const blockchainIds = response.headers
    .get('x-blockchain-ids')
    ?.split(',')
    .map((id) => id.trim());
  const version = response.headers.get('x-action-version')?.trim();

  return {
    blockchainIds,
    version,
  };
};

const componentFactory = (
  parent: Action,
  label: string,
  href: string,
  type: LinkedActionType,
  parameters?: TypedActionParameter[],
): AbstractActionComponent => {
  if (!parameters?.length) {
    return new ButtonActionComponent(parent, label, href, type);
  }

  if (parameters.length > 1) {
    return new FormActionComponent(parent, label, href, type, parameters);
  }

  const [parameter] = parameters;

  if (!parameter.type) {
    return new SingleValueActionComponent(
      parent,
      label,
      href,
      type,
      parameters,
    );
  }

  if (MULTI_VALUE_TYPES.includes(parameter.type)) {
    return new MultiValueActionComponent(parent, label, href, type, parameters);
  }

  return new SingleValueActionComponent(parent, label, href, type, parameters);
};
