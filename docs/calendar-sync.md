# Calendar subscriptions

In Settings → Connections → Calendars, choose Google Calendar, Outlook, or Other iCalendar and paste the provider's HTTPS subscription link. Connections are optional and no calendar is added by default.

Google: Calendar settings → select the calendar → Integrate calendar → Secret address in iCal format. Some managed Google accounts disable private subscription links.

Outlook: Settings → Calendar → Shared calendars → Publish calendar → copy the ICS link. Publishing makes the calendar readable by anyone who has that link; choose the detail level in Outlook before connecting.

Links are stored using Windows DPAPI for the current user. They are never returned to the interface or included in connection errors. The native process refreshes feeds every five minutes while Hover Island is running, without requiring the provider's website to remain open. Sync now refreshes immediately.

Subscriptions are read-only. Changes must be made in the provider's calendar. Events created inside Hover Island remain local and editable. Subscribed events have no edit/delete buttons.

Time zones, all-day dates, recurrence exclusions and moved/cancelled occurrences are handled by ical.js. Expansion is bounded to 1,000 events per feed within the last 31 days and next 370 days, with a work limit for unusual recurrence rules. The UI reports skipped unsupported events. Failed refreshes keep the last good snapshot for the current app session and display the connection error.

Six feeds are supported, with a 2 MB limit per feed, twelve-second timeout, HTTPS-only access and redirects disabled. This does not provide Google/Microsoft OAuth or two-way calendar editing.
