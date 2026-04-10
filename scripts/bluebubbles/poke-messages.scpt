-- Keep Messages.app alive for BlueBubbles.
-- BlueBubbles needs Messages.app running to relay iMessages.
-- This script is run every 5 minutes by the LaunchAgent.
try
	tell application "Messages"
		if not running then
			launch
		end if
		set _chatCount to (count of chats)
	end tell
on error
end try
