import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { AlertsService } from './alerts.service';
import { CreateAlertDto, TestAlertDto } from './dto/create-alert.dto';

@Controller('api/alerts')
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Post()
  async createAlert(@Body() body: CreateAlertDto) {
    return this.alertsService.createAlert(body);
  }

  @Get()
  async listAlerts() {
    return this.alertsService.listAlerts();
  }

  @Delete(':id')
  async deleteAlert(@Param('id') id: string) {
    return this.alertsService.deleteAlert(id);
  }

  @Post('test')
  async testAlert(@Body() body: TestAlertDto) {
    return this.alertsService.testAlert(body);
  }
}
