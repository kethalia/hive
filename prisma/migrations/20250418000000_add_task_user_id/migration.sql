-- AlterTable: add nullable user_id FK to tasks
ALTER TABLE "tasks" ADD COLUMN "user_id" UUID;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
