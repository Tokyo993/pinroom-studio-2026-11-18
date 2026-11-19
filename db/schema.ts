import {sqliteTable,text,integer,index} from 'drizzle-orm/sqlite-core';

export const libraries=sqliteTable('libraries',{
  ownerId:text('owner_id').primaryKey(),
  payload:text('payload').notNull(),
  revision:integer('revision').notNull(),
  updatedAt:integer('updated_at').notNull(),
});
export const assets=sqliteTable('assets',{
  id:text('id').primaryKey(),
  ownerId:text('owner_id').notNull(),
  objectKey:text('object_key').notNull(),
  mime:text('mime').notNull(),
  size:integer('size').notNull(),
  createdAt:integer('created_at').notNull(),
},table=>[index('assets_owner_idx').on(table.ownerId)]);
