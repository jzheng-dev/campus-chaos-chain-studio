# Build and deploy your finished Chain Studio app

Jessica, this is the complete code for your separate Week 8 prompt-chain tool. Use these files as a new project. You do not need to generate a Next.js starter, paste partial components, or replace files later.

Keep using your **existing Design for Gen AI Supabase project**. Create a **new GitHub repository and a new Vercel project** for this tool.

## 1. Open the downloaded folder

Unzip `Chain_Studio_Complete.zip`. Open the `chain-studio` folder inside it.

You should see:

```text
chain-studio/
  app/
  components/
  lib/
  scripts/
  supabase/
    setup.sql
  tests/
  .env.example
  .gitignore
  next.config.ts
  package.json
  package-lock.json
  tsconfig.json
  README.md
  START_HERE.md
  FULL_CODE.md
```

The actual source files are ready to use. `FULL_CODE.md` also contains their complete text, organized by file path, if you prefer to copy and paste individual files. It is a reference copy; the app runs from the source files, not from the Markdown document.

## 2. Run the database setup in your existing Supabase project

1. Open the same Supabase project used by your current public and admin apps.
2. Open **SQL Editor → New query**.
3. Open `supabase/setup.sql` from this folder in VS Code or another plain-text editor.
4. Copy the **entire file**, paste it into the Supabase SQL Editor, and click **Run**.
5. Wait for the successful result. A message such as “Success. No rows returned” is normal for this setup script.

This adds chain versioning, step titles/output types, saved run history, private generated-image storage, and admin-checked database functions. It leaves existing data and table policies in place. The functions are deliberately limited to signed-in superadmins. No service-role key is needed.

If Supabase reports an error, stop here and send the exact error message. Do not delete your existing tables or run unrelated reset scripts.

## 3. Create a new GitHub repository and upload the finished files

Use GitHub in your browser:

1. Open https://github.com/new.
2. Repository name: `campus-chaos-chain-studio`.
3. Choose the visibility your course requires. You can keep it private unless your instructor needs public source access.
4. Leave “Add a README,” “Add .gitignore,” and “Choose a license” unselected. The project already includes its files.
5. Click **Create repository**.
6. On the empty repository page, choose **uploading an existing file**. If the repository already contains something, use **Add file → Upload files**.
7. Drag the **contents of the `chain-studio` folder** into the upload area. Upload the files and folders, not the ZIP file, and not the outer folder itself.
8. On a Mac, press **Command + Shift + period** in Finder to show hidden files. Include `.gitignore` and `.env.example`. The example file contains placeholders only.
9. Use this commit message: `Build Chain Studio prompt chain tool`.
10. Click **Commit changes**.

Check the repository home page: `package.json` should be visible at the top level, alongside `app`, `components`, and `lib`. If it is inside an extra `chain-studio` folder, Vercel's Root Directory must be set to that inner folder instead.

Do not upload a real `.env.local`, API keys, `node_modules`, or `.next`.

## 4. Create the new Vercel project

1. Open https://vercel.com/new.
2. Import your new `campus-chaos-chain-studio` GitHub repository.
3. Project name: `campus-chaos-chain-studio` (or a similar available name).
4. Framework preset: **Next.js**.
5. Root Directory: **./**, assuming you uploaded the inner folder's contents as instructed.
6. Keep the standard build/output settings. The build command is `npm run build`.
7. Under **Environment Variables**, add every variable in the table below before deploying. Select Production and Preview; include Development if you plan to test locally.

| Variable name                          | Value to enter                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`             | The same Supabase project URL used by your existing admin app.                                                                 |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The same public/publishable key used by your existing admin app. This is not the service-role key.                             |
| `GEMINI_API_KEY`                       | Your Google AI Studio Gemini API key. You can reuse the key from your public caption app. Enter the value privately in Vercel. |
| `GEMINI_MODEL`                         | `gemini-3.8-flash`                                                                                                             |
| `GEMINI_IMAGE_MODEL`                   | `gemini-nano-banana-2.1`                                                                                                       |

If your old app uses a different environment-variable name for its Gemini key, copy its **value** into `GEMINI_API_KEY` in this new project.

8. Use Node.js **24.x** in the project's build settings if Vercel asks. The code requires at least Node.js 22.18.
9. Click **Deploy** and wait until the deployment is Ready.

Model names are server settings, so a future model-access change can be handled by editing an environment variable and redeploying, without rewriting source files. Image generation requires image-model access and available quota in your Google project.

## 5. Allow Google login on this app's URLs

Your existing Supabase project already handles Google sign-in. This app uses that same provider configuration.

1. In Vercel, copy your new app's normal production URL.
2. Open the deployment details and copy its unique deployment URL too. You will need that specific URL for submission.
3. In Supabase, go to **Authentication → URL Configuration → Redirect URLs**.
4. Add your production URL with `/auth/callback` appended.
5. Add the exact unique deployment URL with `/auth/callback` appended as a second entry.
6. Save the redirect settings.

For example, if your production URL were `https://campus-chaos-chain-studio.vercel.app`, add:

```text
https://campus-chaos-chain-studio.vercel.app/auth/callback
```

Use the actual URLs Vercel gives you; the example name may not be your deployed domain.

**Keep your existing Site URL and existing Redirect URLs.** Adding this third app does not require removing or changing the public/admin apps' entries. You do not need to change Google's redirect URI because the existing Supabase Auth callback remains the same.

Every new deployment-specific URL must be allowed before you test Google login on it. Add the final submitted deployment URL after your last commit/deployment.

Optional local development: also add `http://localhost:3000/auth/callback`.

## 6. Turn off Vercel deployment protection

1. Open the new Vercel project's **Settings → Deployment Protection**. Some dashboard layouts place this under **Security**.
2. Set the protection level to **None**, or disable the enabled Vercel Authentication/Password Protection controls, depending on your dashboard's layout.
3. Save.
4. Repeat this check for the other two Vercel projects, since the assignment asks for all three links to be accessible.

This removes the Vercel account gate. Your app's own Google login and superadmin restrictions stay active.

## 7. Test the app

Open your new app and choose **Continue with Google**. Use the same account you use for your current superadmin panel.

If you reach the access-denied message, sign in with the correct account and check that its existing row in `profiles` has `is_superadmin` set to `TRUE`. Being signed in by itself is not enough.

### First successful run

1. Choose the **Campus caption lab** starter.
2. Click **Save chain**.
3. Under **Your input**, enter:

```text
A Columbia student guarding three library seats during finals, even though they came alone.
```

4. Click **Run chain** and keep the tab open.
5. Confirm that five captions appear in the final result.
6. Expand each step under **Follow the thread** to see the intermediate outputs and original prompt template.
7. Open **History**, then select your saved run.

These are genuine API calls using your Gemini quota, not sample results.

### Check every technical rubric item

- [ ] Logged out: opening `/studio` takes you to sign-in.
- [ ] Signed-in non-superadmin: the workspace is denied.
- [ ] Superadmin: the workspace opens.
- [ ] Create a new chain and save it; it appears in the sidebar.
- [ ] Change the chain name/description and save; reload to confirm persistence.
- [ ] Add a step, write its prompt, and save.
- [ ] Edit an existing step and save.
- [ ] Move steps with the arrow buttons or drag handle, save, and reload to confirm the order.
- [ ] Delete a step, save, and reload.
- [ ] Run a saved chain and inspect all outputs.
- [ ] Switch chains and confirm the History panel shows only the selected chain's runs.
- [ ] Switch light/dark/system modes; reload to confirm the choice persists.
- [ ] Create a disposable chain, save it, then delete it to check chain deletion.
- [ ] Optional image check: use **Idea → visual**, enter a visual concept, save, and run. Confirm the image is displayed and downloadable.
- [ ] In Incognito, the login page loads without asking for a Vercel account. Workspace access still requires an authorized Google account.

If your instructor will test editing/generation, their Google account must have the intended superadmin profile in your Supabase project. Do not remove the superadmin check to make grading easier.

### Previous-week feedback: the other 50 points

The feedback was not supplied with the uploaded code/database export, so this package cannot claim that category is complete. Review the actual Week 7 comments before submitting. Map each comment to a concrete fix and test it in the relevant app. New functionality in this tool does not automatically satisfy feedback about your older admin/public app.

## 8. Submit the three final deployment-specific URLs

For each of the public app, admin app, and prompt-chain app:

1. Open its Vercel project → **Deployments**.
2. Open the newest successful deployment for the final commit you want graded.
3. Copy that deployment's unique URL from its details. The normal project domain and a moving branch alias are not substitutes for the requested deployment-specific URL.
4. For the prompt-chain app, add that exact URL's `/auth/callback` in Supabase as described in step 5.
5. Test that exact URL in Incognito. A Google sign-in screen is expected; a Vercel sign-in screen is not.

Submit in this format:

```text
Public application: [latest commit-specific deployment URL]
Admin area: [latest commit-specific deployment URL]
Prompt chain tool: [latest commit-specific deployment URL]
```

The URLs cannot be filled in until your actual Vercel deployments exist.

## If something doesn't work

| What you see                                        | What to check                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Setup needed on the entrance page                   | Add both `NEXT_PUBLIC_SUPABASE_...` variables in Vercel and redeploy. Public variables are built into the app.         |
| Google returns you to the wrong app or login fails  | Add the exact current domain plus `/auth/callback` to Supabase Redirect URLs. Keep the existing app entries.           |
| Superadmin access required                          | Use your existing admin Google account. Verify its `profiles.id` matches the Auth user ID and `is_superadmin` is TRUE. |
| “Could not find function” or a missing-column error | Run the entire `supabase/setup.sql` in the same project as the environment variables.                                  |
| Gemini key/model/quota error                        | Check the key, model access, and Google AI Studio quota. Update environment variables and redeploy if you change them. |
| A chain changed in another tab                      | Copy any edits you want to keep, then use the refresh icon beside the save status to reload the saved version.         |
| Unknown/unavailable variable                        | Use `{{input}}`, `{{previous}}`, or a backward reference such as `{{step_1}}` in step 2 or later.                      |
| An image step cannot be saved                       | Image output must be the final step. Move it to the end or change its output to Text.                                  |
| An image link stops loading                         | Open History and click its refresh icon to renew the private signed link.                                              |
| A run says interrupted                              | Check Vercel function logs. Try a shorter chain; runs aren't resumed automatically.                                    |
| The build can't find `package.json`                 | Set Vercel Root Directory to the folder containing `package.json`.                                                     |

For code architecture, limits, and verification details, see README.md. Keep API keys out of GitHub and chat.
