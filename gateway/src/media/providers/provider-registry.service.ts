import { Injectable } from '@nestjs/common';
import type { MediaProvider } from '../../database/entities/media-credential.entity';
import { MediaProviderAdapter, ProviderContractError } from '../media.types';
import { DoubaoMediaAdapter } from './doubao.adapter';
import { GoogleMediaAdapter } from './google.adapter';
import { MiniMaxMediaAdapter } from './minimax.adapter';
import { OpenAiMediaAdapter } from './openai.adapter';

@Injectable()
export class ProviderRegistry {
  private readonly adapters: ReadonlyMap<MediaProvider, MediaProviderAdapter>;

  constructor(
    openai: OpenAiMediaAdapter,
    google: GoogleMediaAdapter,
    doubao: DoubaoMediaAdapter,
    minimax: MiniMaxMediaAdapter,
  ) {
    this.adapters = new Map(
      [openai, google, doubao, minimax].map((adapter) => [adapter.provider, adapter]),
    );
  }

  get(provider: MediaProvider): MediaProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new ProviderContractError('unsupported_provider');
    return adapter;
  }
}
