import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { FileUpload } from '../database/entities/file-upload.entity';
import { FilesController } from './files.controller';
import { FileStorageService } from './file-storage.service';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([FileUpload])],
  controllers: [FilesController],
  providers: [FileStorageService],
  exports: [FileStorageService],
})
export class FilesModule {}
