/* WeVois Tender Portal - Supabase connection.
 *
 * This portal has its OWN Supabase project. Do not point it at the billing
 * project: the tables have the same names and it would collide.
 *
 * Where to find these two values:
 *   Supabase dashboard -> your tender project -> Settings -> API
 *     Project URL  ->  SUPABASE_URL
 *     anon public  ->  SUPABASE_ANON_KEY
 *
 * The anon key is public by design - it is safe in the browser. Row Level
 * Security is what protects the data, and TENDER-SETUP.sql switches it on for
 * every table. NEVER put the service_role key in this file.
 */
const SUPABASE_URL      = 'https://btertydecnruwvvunrhm.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ0ZXJ0eWRlY25ydXd2dnVucmhtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyODk0MjksImV4cCI6MjEwMDg2NTQyOX0.1mvnN7WO0BGfgvOeOxcQ5CiqTFNMeBdLYyMqyxHLsSc';
