"use client";

import { useEffect, useState } from "react";
import { LayoutWrapper } from "@/components/layout-wrapper";
import { MembersTable } from "@/components/members-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Member } from "@/types/database";
import { Search, RefreshCw, Download } from "lucide-react";

export default function MembersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [filteredMembers, setFilteredMembers] = useState<Member[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"trophies" | "name" | "role">("trophies");

  useEffect(() => {
    loadMembers();
  }, []);

  useEffect(() => {
    let filtered = [...members];

    // Search filter
    if (searchQuery) {
      filtered = filtered.filter(
        (m) =>
          m.player_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          m.player_tag.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    // Sort
    filtered.sort((a, b) => {
      switch (sortBy) {
        case "trophies":
          return b.trophies - a.trophies;
        case "name":
          return a.player_name.localeCompare(b.player_name);
        case "role":
          const roleOrder = ["president", "vicepresident", "senior", "member"];
          return (
            roleOrder.indexOf(a.role.toLowerCase()) -
            roleOrder.indexOf(b.role.toLowerCase())
          );
        default:
          return 0;
      }
    });

    setFilteredMembers(filtered);
  }, [members, searchQuery, sortBy]);

  const loadMembers = async () => {
    try {
      setIsRefreshing(true);
      const response = await fetch("/api/members");
      if (response.ok) {
        const data = await response.json();
        setMembers(data.members || []);
      }
    } catch (error) {
      console.error("Error loading members:", error);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  const handleExport = () => {
    const csv = [
      ["Tag", "Name", "Role", "Trophies", "Highest", "3v3 Wins", "Active"].join(","),
      ...members.map((m) =>
        [
          m.player_tag,
          m.player_name,
          m.role,
          m.trophies,
          m.highest_trophies,
          m.trio_victories,
          m.is_active ? "Yes" : "No",
        ].join(",")
      ),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `club-members-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <LayoutWrapper>
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <CardTitle>All Members ({members.length})</CardTitle>
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search members..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 w-full sm:w-64"
                />
              </div>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="trophies">Sort by Trophies</option>
                <option value="name">Sort by Name</option>
                <option value="role">Sort by Role</option>
              </select>
              <Button variant="outline" onClick={loadMembers} size="sm" className="sm:size-default" disabled={isRefreshing}>
                <RefreshCw className={`h-4 w-4 sm:mr-2 ${isRefreshing ? "animate-spin" : ""}`} />
                <span className="hidden sm:inline">{isRefreshing ? "Refreshing..." : "Refresh"}</span>
              </Button>
              <Button variant="outline" onClick={handleExport} size="sm" className="sm:size-default">
                <Download className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Export</span>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : (
            <MembersTable members={filteredMembers} />
          )}
        </CardContent>
      </Card>
    </LayoutWrapper>
  );
}
