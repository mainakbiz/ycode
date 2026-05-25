import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getAllFormSubmissions,
  getFormSubmissionById,
  getFormSummaries,
  updateFormSubmission,
  deleteFormSubmission,
  markAllAsRead,
} from '@/lib/repositories/formSubmissionRepository';

export function registerFormTools(server: McpServer) {
  server.tool(
    'list_forms',
    'List all forms that have received submissions, with counts and latest submission date.',
    {},
    async () => {
      const summaries = await getFormSummaries();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(summaries),
        }],
      };
    },
  );

  server.tool(
    'list_form_submissions',
    'List submissions for a specific form, optionally filtered by status.',
    {
      form_id: z.string().describe('The form ID (layer ID of the form element)'),
      status: z.enum(['new', 'read', 'archived', 'spam']).optional().describe('Filter by status'),
    },
    async ({ form_id, status }) => {
      const submissions = await getAllFormSubmissions(form_id, status);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(submissions.map((s) => ({
            id: s.id,
            form_id: s.form_id,
            payload: s.payload,
            status: s.status,
            created_at: s.created_at,
          }))),
        }],
      };
    },
  );

  server.tool(
    'get_form_submission',
    'Get a single form submission by ID with full payload and metadata.',
    {
      submission_id: z.string().describe('The submission ID'),
    },
    async ({ submission_id }) => {
      const submission = await getFormSubmissionById(submission_id);
      if (!submission) {
        return { content: [{ type: 'text' as const, text: `Error: Submission "${submission_id}" not found.` }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(submission) }],
      };
    },
  );

  server.tool(
    'update_form_submission_status',
    'Update the status of a form submission (e.g. mark as read, archived, or spam).',
    {
      submission_id: z.string().describe('The submission ID'),
      status: z.enum(['new', 'read', 'archived', 'spam']).describe('New status'),
    },
    async ({ submission_id, status }) => {
      const submission = await updateFormSubmission(submission_id, { status });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ message: `Submission marked as "${status}"`, submission }),
        }],
      };
    },
  );

  server.tool(
    'mark_all_submissions_read',
    'Mark all new submissions for a form as read.',
    {
      form_id: z.string().describe('The form ID'),
    },
    async ({ form_id }) => {
      await markAllAsRead(form_id);
      return {
        content: [{ type: 'text' as const, text: `All new submissions for form ${form_id} marked as read.` }],
      };
    },
  );

  server.tool(
    'delete_form_submission',
    'Permanently delete a form submission.',
    {
      submission_id: z.string().describe('The submission ID to delete'),
    },
    async ({ submission_id }) => {
      await deleteFormSubmission(submission_id);
      return {
        content: [{ type: 'text' as const, text: `Submission ${submission_id} deleted successfully.` }],
      };
    },
  );
}
