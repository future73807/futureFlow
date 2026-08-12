import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { MediaAsset } from '../database/entities/media-asset.entity';
import { MediaCredential } from '../database/entities/media-credential.entity';
import { MediaJob } from '../database/entities/media-job.entity';
import { MediaAssetService } from './media-asset.service';
import { MediaController } from './media.controller';
import { MediaCredentialCrypto } from './media-credential.crypto';
import { MediaCredentialService } from './media-credential.service';
import { MediaJobService } from './media-job.service';
import { ProviderHttpClient } from './provider-http.client';
import { DoubaoMediaAdapter } from './providers/doubao.adapter';
import { GoogleMediaAdapter } from './providers/google.adapter';
import { MiniMaxMediaAdapter } from './providers/minimax.adapter';
import { OpenAiMediaAdapter } from './providers/openai.adapter';
import { ProviderRegistry } from './providers/provider-registry.service';
import { MediaExecutionGuard } from './media-execution.guard';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([MediaCredential, MediaJob, MediaAsset]),
  ],
  controllers: [MediaController],
  providers: [
    MediaCredentialCrypto,
    MediaCredentialService,
    MediaAssetService,
    MediaJobService,
    ProviderHttpClient,
    OpenAiMediaAdapter,
    GoogleMediaAdapter,
    DoubaoMediaAdapter,
    MiniMaxMediaAdapter,
    ProviderRegistry,
    MediaExecutionGuard,
  ],
  exports: [MediaCredentialService, MediaJobService],
})
export class MediaModule {}
