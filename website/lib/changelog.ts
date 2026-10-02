import { defineCollections } from 'fumadocs-mdx/macro';
import { pageSchema } from 'fumadocs-core/source/schema';
import { z } from 'zod';

// One entry per release, converted from docs/change-log; `date` comes from the
// release tag.
export const changelog = defineCollections({
  type: 'doc',
  dir: 'content/changelog',
  schema: pageSchema.extend({ version: z.string(), date: z.string().optional() }),
});
