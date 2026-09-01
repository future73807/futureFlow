import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Param,
  Post,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CreateKnowledgeDatasetDto, CreateKnowledgeDocumentDto } from './dto/knowledge.dto';
import { KnowledgeService } from './knowledge.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const strictValidation = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

@Injectable()
@UseGuards(JwtAuthGuard)
@UsePipes(strictValidation)
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  private assertDatasetId(datasetId: string): void {
    if (!UUID.test(datasetId)) {
      throw new BadRequestException('知识库 ID 格式无效');
    }
  }

  private assertDocumentId(documentId: string): void {
    if (!UUID.test(documentId)) {
      throw new BadRequestException('知识文档 ID 格式无效');
    }
  }

  @Get('status')
  async status(@Request() req: any) {
    return {
      enabled: await this.knowledge.isEnabled(),
      requestedBy: req.user?.id,
    };
  }

  @Get('datasets')
  listDatasets() {
    return this.knowledge.listDatasets();
  }

  @Post('datasets')
  createDataset(@Body() dto: CreateKnowledgeDatasetDto) {
    return this.knowledge.createDataset(dto.name.trim(), dto.description?.trim() || '');
  }

  @Delete('datasets/:datasetId')
  async deleteDataset(@Param('datasetId') datasetId: string) {
    this.assertDatasetId(datasetId);
    await this.knowledge.deleteDataset(datasetId);
    return { ok: true };
  }

  @Get('datasets/:datasetId/documents')
  listDocuments(@Param('datasetId') datasetId: string) {
    this.assertDatasetId(datasetId);
    return this.knowledge.listDocuments(datasetId);
  }

  @Post('datasets/:datasetId/documents')
  createDocument(
    @Param('datasetId') datasetId: string,
    @Body() dto: CreateKnowledgeDocumentDto,
  ) {
    this.assertDatasetId(datasetId);
    return this.knowledge.createDocumentByText(datasetId, dto.name.trim(), dto.text);
  }

  @Delete('datasets/:datasetId/documents/:documentId')
  async deleteDocument(
    @Param('datasetId') datasetId: string,
    @Param('documentId') documentId: string,
  ) {
    this.assertDatasetId(datasetId);
    this.assertDocumentId(documentId);
    await this.knowledge.deleteDocument(datasetId, documentId);
    return { ok: true };
  }
}
