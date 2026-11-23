using Microsoft.EntityFrameworkCore;

namespace __NAME__.Infrastructure.Persistence;

/// <summary>
/// The database. Only Infrastructure sees it: use cases reach data through the ports they
/// declare, implemented in this project. Lazy loading stays off, so a query that was not
/// written does not run.
/// </summary>
public sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    protected override void OnModelCreating(ModelBuilder modelBuilder) =>
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);
}
