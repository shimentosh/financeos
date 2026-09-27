import { Global, Module } from "@nestjs/common";
import { FilesController } from "./files.controller.js";
import { StorageService } from "./storage.service.js";
import { StorageAdminController } from "./storage-admin.controller.js";
import { StorageAdminService } from "./storage-admin.service.js";

@Global()
@Module({
  controllers: [FilesController, StorageAdminController],
  providers: [StorageService, StorageAdminService],
  exports: [StorageService],
})
export class StorageModule {}
