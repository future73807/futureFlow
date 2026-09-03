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

  private currentUserId(req: any): string {
    const userId = req?.user?.id;
    if (!userId) throw new BadRequestException('未认证');
    return String(userId);
  }

  private isAdmin(req: any): boolean {
    return req?.user?.role === 'admin';
  }

  @Get('status')
  async status(@Request() req: any) {
    return {
      enabled: await this.knowledge.isEnabled(),
      requestedBy: req.user?.id,
    };
  }

  @Get('datasets')
  listDatasets(@Request() req: any) {
    return this.knowledge.listDatasets(this.currentUserId(req));
  }

  @Post('datasets')
  createDataset(@Request() req: any, @Body() dto: CreateKnowledgeDatasetDto) {
    return this.knowledge.createDataset(
      this.currentUserId(req),
      dto.name.trim(),
      dto.description?.trim() || '',
      this.isAdmin(req),
    );
  }

  @Delete('datasets/:datasetId')
  async deleteDataset(@Request() req: any, @Param('datasetId') datasetId: string) {
    this.assertDatasetId(datasetId);
    await this.knowledge.deleteDataset(this.currentUserId(req), datasetId, this.isAdmin(req));
    return { ok: true };
  }

  @Get('datasets/:datasetId/documents')
  listDocuments(@Request() req: any, @Param('datasetId') datasetId: string) {
    this.assertDatasetId(datasetId);
    return this.knowledge.listDocuments(this.currentUserId(req), datasetId, this.isAdmin(req));
  }

  @Post('datasets/:datasetId/documents')
  createDocument(
    @Request() req: any,
    @Param('datasetId') datasetId: string,
    @Body() dto: CreateKnowledgeDocumentDto,
  ) {
    this.assertDatasetId(datasetId);
    return this.knowledge.createDocumentByText(
      this.currentUserId(req),
      datasetId,
      dto.name.trim(),
      dto.text,
      this.isAdmin(req),
    );
  }

  @Delete('datasets/:datasetId/documents/:documentId')
  async deleteDocument(
    @Request() req: any,
    @Param('datasetId') datasetId: string,
    @Param('documentId') documentId: string,
  ) {
    this.assertDatasetId(datasetId);
    this.assertDocumentId(documentId);
    await this.knowledge.deleteDocument(this.currentUserId(req), datasetId, documentId, this.isAdmin(req));
    return { ok: true };
  }
}
